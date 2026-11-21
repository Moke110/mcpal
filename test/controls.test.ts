import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Server as TcpServer } from 'node:net'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import minecraftData from 'minecraft-data'
import protocol from 'minecraft-protocol'
import prismarineChunk from 'prismarine-chunk'
import type { PCChunk } from 'prismarine-chunk'
import { Vec3 } from 'vec3'
import { connect } from '../src/client.ts'
import { readConfig } from '../src/config.ts'
import { parseCommand } from '../src/controls.ts'
import { createTasks } from '../src/tasks.ts'
import { runRoundTrip } from '../src/round-trip-controller.ts'

test('parses supported commands and requires an explicit offline control opt-in', () => {
  assert.equal(parseCommand('hello'), null)
  assert.deepEqual(parseCommand('!come'), { kind: 'come', arg: '' })
  assert.deepEqual(parseCommand('!act {"kind":"move"}'), { kind: 'act', arg: '{"kind":"move"}' })
  assert.throws(() => parseCommand('!follow Steve'), /Usage/)
  assert.throws(() => parseCommand('!unknown'), /Unknown/)
  const env = { MC_HOST: '127.0.0.1', MC_PORT: '25565', MC_USERNAME: 'TestBot',
    MC_AUTH: 'offline', MC_CONTROL: 'true', MC_AUTHORIZED_PLAYERS: 'Owner' }
  assert.throws(() => readConfig(env), /MC_ALLOW_OFFLINE_CONTROL/)
  assert.ok(readConfig({ ...env, MC_ALLOW_OFFLINE_CONTROL: 'true' }).control?.players.has('owner'))
})

test('deduplicates identical work and waits for cancellation cleanup before replacing it', async () => {
  const order: string[] = []
  const tasks = createTasks(() => {}, () => assert.fail('unexpected recovery'))
  const { promise: entered, resolve: started } = Promise.withResolvers<void>()
  const first = tasks.submit('follow', async (signal) => {
    started()
    try { await delay(5000, undefined, { signal }) }
    finally {
      await delay(25)
      order.push('cleaned')
    }
    return 'unexpected'
  })
  await entered
  assert.strictEqual(tasks.submit('follow', async () => 'duplicate'), first)
  const second = tasks.submit('move', async () => {
    order.push('started second')
    return 'arrived'
  })
  assert.equal((await first).state, 'cancelled')
  assert.equal((await second).state, 'completed')
  assert.deepEqual(order, ['cleaned', 'started second'])
})

test('closes the session on timeout when work ignores cancellation', async () => {
  let recovered = false
  const tasks = createTasks(() => {}, () => { recovered = true }, 25)
  const { promise: hanging, resolve } = Promise.withResolvers<string>()
  const result = await tasks.submit('stuck', async () => hanging, 25)
  assert.equal(result.state, 'timed_out')
  assert.equal(recovered, true)
  assert.equal((await tasks.submit('next', async () => 'unexpected')).state, 'failed')
  resolve('late response')
})

test('an external caller can cancel its action without waiting for the task deadline', async () => {
  const tasks = createTasks(() => {}, () => assert.fail('unexpected recovery'))
  const caller = new AbortController()
  const { promise: entered, resolve: start } = Promise.withResolvers<void>()
  const result = tasks.submit('move', async (signal) => {
    start()
    await delay(3000, undefined, { signal })
    return 'unexpected'
  }, 5000, 'move', caller.signal)
  await entered
  caller.abort()
  assert.deepEqual(await result, { state: 'cancelled', message: 'Caller cancelled the action' })
})

test('state machine exits when the world never becomes ready and the caller cancels', async () => {
  const states: string[] = []
  const result = await runRoundTrip({
    read: () => null,
    readBlock: () => null,
    execute: async () => assert.fail('Action started before state was available'),
    stop: () => assert.fail('Cancelled a different caller’s work'),
  }, { x: 1, y: 64, z: 2 }, AbortSignal.timeout(50), state => states.push(state))
  assert.equal(result.state, 'cancelled')
  assert.deepEqual(states, ['waiting', 'cancelled'])
})

test('26.1: authorizes commands and executes movement, block and inventory skills', { timeout: 22_000 }, async (t) => {
  const version = '26.1'
  const data = minecraftData(version)
  const host = '127.0.0.1'
  const server = protocol.createServer({ host, port: 0, version, 'online-mode': false })
  t.after(() => server.close())
  await once(server, 'listening')
  const address = (server as typeof server & { socketServer: TcpServer }).socketServer.address()
  assert.ok(address && typeof address !== 'string')
  const events: { event: string; fields?: Record<string, unknown> }[] = []
  const client = connect({
    host, port: address.port, username: 'Companion', auth: 'offline', version, snapshotIntervalMs: 1000,
    control: { players: new Set(['owner']) },
  }, (event, fields) => events.push({ event, fields }), () => assert.fail('unexpected authentication prompt'))
  t.after(() => client.close())
  assert.equal(client.getStatus(), null)
  const [peer] = await once(server, 'playerJoin') as [protocol.ServerClient]
  peer.write('login', { ...data.loginPacket, entityId: peer.id })
  peer.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
  const empty = { itemCount: 0 }
  const item = (name: string, itemCount: number) => ({
    itemCount, itemId: data.itemsByName[name]!.id,
    addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [],
  })
  const items = Array.from({ length: 46 }, (_, slot) => {
    if (slot === 36) return item('dirt', 2)
    if (slot === 37) return item('oak_log', 1)
    if (slot === 38) return item('raw_iron', 1)
    if (slot === 39) return item('coal', 1)
    return empty
  })
  peer.write('window_items', { windowId: 0, stateId: 1, carriedItem: { itemCount: 0 }, items })
  const Chunk = (prismarineChunk as unknown as (version: string) => typeof PCChunk)(version)
  const column = new Chunk({ minY: -64, worldHeight: 384 })
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) column.setBlockStateId(new Vec3(x, 63, z), data.blocksByName.stone!.defaultState)
  }
  peer.write('map_chunk', {
    x: 0, z: 0, chunkData: column.dump(), heightmaps: [], blockEntities: [],
    skyLightMask: [], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [], skyLight: [], blockLight: [],
  })
  const owner = randomUUID()
  const bystander = randomUUID()
  peer.write('player_info', {
    action: { add_player: true }, data: [
      { uuid: owner, player: { name: 'Owner', properties: [] } },
      { uuid: bystander, player: { name: 'Bystander', properties: [] } },
    ],
  })
  peer.write('spawn_entity', {
    x: 11.5, y: 64, z: 5.5, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, headPitch: 0, objectData: 0,
    entityId: 43, objectUUID: owner, type: data.entitiesByName.player!.id,
  })
  peer.write('position', {
    x: 3.5, y: 64, z: 5.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 1,
  })
  await expect(() => client.getStatus()?.blocks[0]?.name === 'stone', 'spawn on loaded terrain')
  assert.equal(client.io.readBlock({ x: 3, y: 63, z: 5 })?.name, 'stone')
  assert.equal(client.io.readBlock({ x: 5000, y: 63, z: 5000 }), null)
  let index = 0
  function chat(sender: string, name: string, message: string) {
    peer.write('player_chat', {
      globalIndex: index++, index, plainMessage: message, type: { chatType: 1 }, senderUuid: sender,
      timestamp: BigInt(Date.now()), salt: 0n, previousMessages: [], filterType: 0,
      networkName: { type: 'compound', value: { text: { type: 'string', value: name } } },
    })
  }
  chat(bystander, 'Owner', '!follow')
  chat(owner, 'Owner', '!come')
  await expect(() => events.some(({ event }) => event === 'task_finished'), 'come completion')
  assert.deepEqual(events.filter(({ event }) => event === 'command_received').map(({ fields }) => fields?.command), ['come'])
  assert.deepEqual(events.find(({ event }) => event === 'task_finished')?.fields?.result,
    { state: 'completed', message: 'Reached destination' })
  assert.ok((client.getStatus()?.position.x ?? 0) >= 9)
  chat(owner, 'Owner', '!follow')
  await expect(() => client.getStatus()?.currentTask?.label === 'follow', 'follow started')
  chat(owner, 'Owner', '!stop')
  await expect(() => events.filter(({ event }) => event === 'task_finished').length === 2, 'follow stopped')
  assert.equal(client.getStatus()?.currentTask, null)
  assert.deepEqual(events.filter(({ event }) => event === 'task_finished').at(-1)?.fields?.result,
    { state: 'cancelled', message: 'Stopped by operator' })

  const at = { x: 9, y: 64, z: 7 }
  const against = { ...at, y: 63 }
  const dirt = data.blocksByName.dirt!.defaultState
  const stone = data.blocksByName.stone!.defaultState
  peer.once('block_place', (packet) => {
    assert.deepEqual(packet.location, against)
    setTimeout(() => {
      peer.write('block_change', { location: against, type: stone })
      peer.write('block_change', { location: at, type: dirt })
    }, 100)
  })
  client.command?.(`act ${JSON.stringify({ kind: 'place', at, against, item: 'dirt' })}`)
  await expect(() => events.filter(({ event }) => event === 'task_finished').length === 3, 'block placement')
  assert.deepEqual(events.filter(({ event }) => event === 'task_finished').at(-1)?.fields?.result,
    { state: 'completed', message: 'Placed dirt' })
  peer.on('block_dig', (packet) => {
    if (packet.status !== 2) return
    assert.deepEqual(packet.location, at)
    peer.write('block_change', { location: at, type: data.blocksByName.air!.defaultState })
  })
  client.command?.(`act ${JSON.stringify({ kind: 'mine', at })}`)
  await expect(() => events.filter(({ event }) => event === 'task_finished').length === 4, 'block removal')
  assert.deepEqual(events.filter(({ event }) => event === 'task_finished').at(-1)?.fields?.result,
    { state: 'completed', message: 'Mined dirt' })

  let state = 10
  const title = { type: 'compound', value: { text: { type: 'string', value: 'Fixture' } } }
  const finished = () => events.filter(({ event }) => event === 'task_finished')
  async function action(task: Record<string, unknown>, message: string) {
    const next = finished().length + 1
    client.command?.(`act ${JSON.stringify(task)}`)
    await expect(() => finished().length === next, String(task.kind))
    assert.deepEqual(finished().at(-1)?.fields?.result, { state: 'completed', message })
  }
  function openMenu(windowId: number, inventoryType: number, containerItems: number) {
    peer.write('open_window', { windowId, inventoryType, windowTitle: title })
    publishMenu(windowId, containerItems)
  }
  function publishMenu(windowId: number, containerItems: number, firstItem = empty) {
    const player = items.slice(9, 45)
    const storage = Array.from({ length: containerItems }, (_, slot) => slot === 0 ? firstItem : empty)
    peer.write('window_items', { windowId, stateId: state++, carriedItem: empty, items: [...storage, ...player] })
  }
  async function writeBlock(name: string) {
    peer.write('block_change', { location: at, type: data.blocksByName[name]!.defaultState })
    await delay(100)
  }

  await writeBlock('lever')
  peer.once('block_place', () => peer.write('block_change', { location: at, type: data.blocksByName.lever!.defaultState - 1 }))
  await action({ kind: 'interact', at }, 'Activated lever')

  await writeBlock('chest')
  for (const [kind, id] of [['deposit', 1], ['withdraw', 2]] as const) {
    const depositing = kind === 'deposit'
    const clickSlots: number[] = []
    peer.once('block_place', () => {
      peer.write('open_window', { windowId: id, inventoryType: 2, windowTitle: title })
      publishMenu(id, 27, depositing ? empty : item('dirt', 1))
    })
    const onClick = (packet: { windowId: number; slot: number; stateId: number }) => {
      if (packet.windowId !== id) return
      if (packet.stateId !== -1) {
        clickSlots.push(packet.slot)
        return
      }
      assert.ok(clickSlots.includes(0), 'chest slot clicked')
      assert.ok(clickSlots.some(slot => slot >= 27), 'player slot clicked')
      items[36] = item('dirt', depositing ? 1 : 2)
      publishMenu(id, 27, depositing ? item('dirt', 1) : empty)
    }
    peer.on('window_click', onClick)
    await action({ kind, at, item: 'dirt', count: 1 }, `${kind}: 1 dirt`)
    peer.off('window_click', onClick)
  }

  const crafting = (packet: { windowId: number; slot: number; stateId: number }) => {
    if (packet.windowId !== 0) return
    if (packet.stateId === -1) {
      items[37] = item('oak_planks', 4)
      peer.write('window_items', { windowId: 0, stateId: state++, carriedItem: empty, items })
    } else if (packet.slot === 0) {
      peer.write('set_slot', { windowId: 0, stateId: state++, slot: 0, item: empty })
    } else if (packet.slot >= 1 && packet.slot <= 4) {
      peer.write('set_slot', { windowId: 0, stateId: state++, slot: 0, item: item('oak_planks', 4) })
    }
  }
  peer.on('window_click', crafting)
  await action({ kind: 'craft', item: 'oak_planks', count: 4 }, 'Crafted 4 oak_planks')
  peer.off('window_click', crafting)

  await writeBlock('furnace')
  peer.once('block_place', () => openMenu(3, 14, 3))
  const furnace = (packet: { windowId: number; slot: number; stateId: number }) => {
    if (packet.windowId !== 3) return
    if (packet.stateId === -1) {
      items[38] = item('iron_ingot', 1)
      items[39] = empty
      publishMenu(3, 3)
    } else if (packet.slot === 1) {
      setTimeout(() => {
        for (const [slot, content] of [[0, empty], [1, empty], [2, item('iron_ingot', 1)]] as const) {
          peer.write('set_slot', { windowId: 3, stateId: state++, slot, item: content })
        }
      }, 100)
    }
  }
  peer.on('window_click', furnace)
  await action({ kind: 'smelt', at, item: 'raw_iron', count: 1, fuel: 'coal', fuelCount: 1, output: 'iron_ingot' }, 'Collected 1 iron_ingot')
  const states: string[] = []
  const roundTrip = await runRoundTrip(client.io, { x: 6, y: 64, z: 5 }, AbortSignal.timeout(6000), state => states.push(state))
  assert.equal(roundTrip.state, 'completed')
  assert.deepEqual(states, ['waiting', 'moving_out', 'checking_target', 'returning', 'checking_origin', 'completed'])
  client.close()
  assert.equal((await client.closed).requested, true)

  async function expect(predicate: () => boolean, label: string) {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (predicate()) return
      await delay(50)
    }
    assert.fail(`Did not observe ${label}: ${JSON.stringify(events.slice(-8))}`)
  }
})
