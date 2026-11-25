import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MinecraftIO } from '../src/io.ts'
import type { Observation, Position } from '../src/perception.ts'
import { runWorkstations } from '../src/workstation-controller.ts'
import type { RunFixture } from '../src/workstation-fixture.ts'

const table = { x: 1, y: 65, z: 0 }
const furnace = { x: 0, y: 65, z: 1 }
const key = (at: Position) => `${at.x},${at.y},${at.z}`

for (const scenario of ['success', 'missing output', 'cancelled'] as const) {
  test(`workstation state machine checks results and cleans up after ${scenario}`, async () => {
    const controller = new AbortController()
    const blocks = new Map<string, string>()
    const calls: string[] = []
    const states: string[] = []
    const inventory = new Map<string, number>()
    const observation: Observation = {
      schemaVersion: 1, username: 'Companion', connection: 'spawned', version: '26.1', dimension: 'overworld',
      position: { x: 0.5, y: 64, z: 0.5 }, orientation: { yawRadians: 0, pitchRadians: 0 },
      health: 20, food: 20, currentTask: null, inventory: [], nearby: { radius: 32, players: [], entities: [] }, blocks: [],
    }
    const completed = { state: 'completed', message: 'done' } as const
    const io: MinecraftIO = {
      read: () => ({ ...observation, inventory: [...inventory].map(([name, count], slot) => ({ slot, name, count })) }),
      readBlock: position => ({ position, name: blocks.get(key(position)) ?? (position.y === 63 ? 'grass_block' : 'air'), stateId: 0 }),
      stop: () => assert.fail('Controller should cancel its own actions'),
      async execute(action, signal) {
        calls.push(action.kind === 'mine' ? `mine:${key(action.at)}` : action.kind)
        assert.equal(signal?.aborted, false)
        switch (action.kind) {
          case 'place':
            blocks.set(key(action.at), action.item)
            break
          case 'craft':
            assert.deepEqual(action.table, table)
            inventory.delete('cobblestone')
            inventory.set('furnace', 1)
            break
          case 'smelt':
            assert.deepEqual(action.at, furnace)
            if (scenario === 'cancelled') {
              controller.abort()
              return { state: 'cancelled', message: 'operator interrupted' }
            }
            inventory.delete('raw_iron')
            inventory.delete('coal')
            if (scenario === 'success') inventory.set('iron_ingot', 1)
            break
          case 'mine':
            blocks.delete(key(action.at))
            break
          default:
            assert.fail('Unexpected test action')
        }
        return completed
      },
    }
    const fixture: RunFixture = async (action, signal) => {
      calls.push(action.kind)
      assert.equal(signal.aborted, false)
      if (action.kind === 'seed') {
        for (const [name, count] of [['crafting_table', 1], ['cobblestone', 8], ['raw_iron', 1], ['coal', 1]] as const) {
          inventory.set(name, count)
        }
      }
      if (action.kind === 'clear') inventory.clear()
      return completed
    }
    const result = await runWorkstations(io, fixture, table, furnace, controller.signal, state => states.push(state))
    assert.equal(result.state, scenario === 'success' ? 'completed' : scenario === 'cancelled' ? 'cancelled' : 'failed')
    assert.equal(states.includes('checking_craft'), true)
    assert.equal(states.includes('checking_smelt'), scenario === 'success')
    if (scenario === 'missing output') assert.match(result.message ?? '', /Expected 1 iron_ingot, observed 0/)
    assert.deepEqual(calls.slice(-6), [
      'drain', `mine:${key(furnace)}`, `mine:${key({ ...furnace, y: 64 })}`,
      `mine:${key(table)}`, `mine:${key({ ...table, y: 64 })}`, 'clear',
    ])
    assert.equal(blocks.size, 0)
    assert.equal(inventory.size, 0)
    assert.deepEqual(result.cleanupErrors, [])
  })
}
