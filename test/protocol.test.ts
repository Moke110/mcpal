import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Server as TcpServer } from 'node:net'
import { test } from 'node:test'
import minecraftData from 'minecraft-data'
import protocol from 'minecraft-protocol'
import { connect } from '../src/client.ts'
import type { Observation } from '../src/perception.ts'

for (const version of ['1.21.11', '26.1']) {
  test(`reads server packets and disconnects on ${version}`, { timeout: 12_000 }, (t) => observeSession(t, version))
}

async function observeSession(t: import('node:test').TestContext, version: string) {
  const data = minecraftData(version)
  const host = '127.0.0.1'
  const server = protocol.createServer({ host, port: 0, version, 'online-mode': false })
  t.after(() => server.close())
  await once(server, 'listening')
  const address = (server as typeof server & { socketServer: TcpServer }).socketServer.address()
  assert.ok(address && typeof address !== 'string')

  const events: string[] = []
  const { promise: firstSnapshot, resolve: receive } = Promise.withResolvers<Observation>()
  const { promise: nextDimension, resolve: receiveNextDimension } = Promise.withResolvers<Observation>()
  const client = connect({
    host, port: address.port, username: 'Companion', auth: 'offline',
    version: false, snapshotIntervalMs: 1000,
  }, (event, fields) => {
    events.push(event)
    if (event === 'snapshot') {
      const observation = fields?.observation as Observation
      receive(observation)
      if (observation.dimension === 'the_nether') receiveNextDimension(observation)
    }
  }, () => assert.fail('offline login requested Microsoft authentication'))
  t.after(() => client.close())
  const [peer] = await once(server, 'playerJoin') as [protocol.ServerClient]
  peer.write('login', { ...data.loginPacket, entityId: peer.id })
  peer.write('update_health', { health: 17, food: 14, foodSaturation: 3 })
  peer.write('window_items', {
    windowId: 0, stateId: 1, carriedItem: { itemCount: 0 },
    items: [{
      itemCount: 3, itemId: data.itemsByName.apple!.id,
      addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [],
    }],
  })
  const position = { x: 10.5, y: 72, z: -4.25 }
  const playerUuid = randomUUID()
  peer.write('player_info', {
    action: { add_player: true }, data: [{ uuid: playerUuid, player: { name: 'HostPlayer', properties: [] } }],
  })
  const entityPose = {
    x: 12.5, y: 72, z: -4.25, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, headPitch: 0, objectData: 0,
  }
  peer.write('spawn_entity', {
    ...entityPose, entityId: 42, objectUUID: randomUUID(), type: data.entitiesByName.pig!.id,
  })
  peer.write('spawn_entity', {
    ...entityPose, entityId: 43, objectUUID: playerUuid, type: data.entitiesByName.player!.id,
  })
  peer.write('position', {
    ...position, dx: 0, dy: 0, dz: 0, yaw: 90, pitch: 0, flags: 0, teleportId: 1,
  })

  const snapshot = await Promise.race([
    firstSnapshot,
    client.closed.then((end) => assert.fail(`Disconnected before snapshot: ${end.reason}`)),
  ])
  assert.deepEqual(events, ['connecting', 'login', 'spawned', 'snapshot'])
  assert.equal(snapshot.username, 'Companion')
  assert.equal(snapshot.version, version)
  assert.match(snapshot.dimension ?? '', /overworld/u)
  assert.deepEqual(snapshot.position, position)
  assert.ok(Number.isFinite(snapshot.orientation.yawRadians))
  assert.equal(snapshot.health, 17)
  assert.equal(snapshot.food, 14)
  assert.deepEqual(snapshot.inventory, [{ slot: 0, name: 'apple', count: 3 }])
  assert.equal(snapshot.nearby.entities[0]?.name, 'pig')
  assert.equal(snapshot.nearby.entities[0]?.distance, 2)
  assert.equal(snapshot.nearby.players[0]?.username, 'HostPlayer')
  assert.deepEqual(snapshot.blocks.map((block) => block.name), [null, null, null])
  if (version === '26.1') {
    const login = data.loginPacket
    assert.ok(login.dimensionCodec)
    assert.ok('worldState' in login && login.worldState && typeof login.worldState === 'object')
    const nether = login.dimensionCodec['minecraft:dimension_type'].entries
      .findIndex(({ key }: { key: string }) => key === 'minecraft:the_nether')
    assert.ok(nether >= 0)
    peer.write('respawn', {
      worldState: { ...login.worldState, dimension: nether, name: 'minecraft:the_nether' },
      copyMetadata: 0,
    })
    peer.write('position', { ...position, dx: 0, dy: 0, dz: 0, yaw: 90, pitch: 0, flags: 0, teleportId: 2 })
    peer.write('update_health', { health: 17, food: 14, foodSaturation: 3 })
    const current = await nextDimension
    assert.deepEqual(current.nearby.players, [])
    assert.deepEqual(current.nearby.entities, [])
    assert.equal(current.inventory, null)
  }
  client.close()
  assert.equal((await client.closed).requested, true)
  assert.equal(events.at(-1), 'disconnected')
}

test('reports a server kick followed by an unrequested disconnect', { timeout: 12_000 }, async (t) => {
  const host = '127.0.0.1'
  const version = '1.21.11'
  const server = protocol.createServer({ host, port: 0, version, 'online-mode': false })
  t.after(() => server.close())
  await once(server, 'listening')
  const address = (server as typeof server & { socketServer: TcpServer }).socketServer.address()
  assert.ok(address && typeof address !== 'string')

  server.on('playerJoin', (peer) => {
    peer.write('kick_disconnect', {
      reason: { type: 'compound', value: { text: { type: 'string', value: 'Integration test kick' } } },
    })
    peer.socket.end()
  })
  const events: string[] = []
  const client = connect({
    host, port: address.port, username: 'Companion', auth: 'offline', version, snapshotIntervalMs: 1000,
  }, (event) => events.push(event), () => assert.fail('unexpected authentication prompt'))
  t.after(() => client.close())

  assert.equal((await client.closed).requested, false)
  assert.deepEqual(events, ['connecting', 'kicked', 'disconnected'])
})
