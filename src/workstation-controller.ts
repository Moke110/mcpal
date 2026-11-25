import { setTimeout as delay } from 'node:timers/promises'
import type { Action } from './actions.ts'
import type { MinecraftIO } from './io.ts'
import type { Position } from './perception.ts'
import type { TaskResult } from './tasks.ts'
import type { RunFixture } from './workstation-fixture.ts'

type SiteBlock = { at: Position; name: 'crafting_table' | 'furnace' | 'glass'; attempted: boolean }
type Station = SiteBlock & { platform?: SiteBlock; ground?: { at: Position; name: string } }
type Phase = 'waiting' | 'seeding' | 'placing_platforms' | 'placing_table' | 'crafting' | 'checking_craft' | 'placing_furnace' |
  'smelting' | 'checking_smelt' | 'cleaning' | 'completed' | 'failed' | 'cancelled'
type Progress = (state: Phase, fields?: Record<string, unknown>) => void

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function runWorkstations(io: MinecraftIO, fixture: RunFixture, tableAt: Position, furnaceAt: Position,
  signal: AbortSignal, progress: Progress) {
  const table: Station = { at: tableAt, name: 'crafting_table', attempted: false }
  const furnace: Station = { at: furnaceAt, name: 'furnace', attempted: false }
  let dimension: string | null = null
  let staged = false
  let outcome: 'completed' | 'failed' | 'cancelled' = 'completed'
  let failure: string | undefined
  const cleanupErrors: string[] = []

  function ensureCompleted(result: TaskResult) {
    if (result.state === 'cancelled') throw new DOMException(result.message, 'AbortError')
    if (result.state !== 'completed') throw new Error(result.message)
  }

  function checkDimension() {
    if (!dimension || io.read()?.dimension !== dimension) throw new Error('Test dimension is unavailable')
  }

  function verifyInventory(expected: Record<string, number>) {
    checkDimension()
    const inventory = io.read()?.inventory
    if (!inventory) throw new Error('Inventory is unavailable')
    for (const [name, count] of Object.entries(expected)) {
      const observed = inventory.reduce((total, item) => total + (item.name === name ? item.count : 0), 0)
      if (observed !== count) throw new Error(`Expected ${count} ${name}, observed ${observed}`)
    }
  }

  async function execute(action: Action, deadline: AbortSignal) {
    checkDimension()
    ensureCompleted(await io.execute(action, deadline))
  }

  async function place(station: SiteBlock) {
    if (io.readBlock(station.at)?.name !== 'air') throw new Error(`${station.name} site is no longer empty`)
    station.attempted = true
    await execute({ kind: 'place', at: station.at, against: { ...station.at, y: station.at.y - 1 }, item: station.name }, signal)
    if (io.readBlock(station.at)?.name !== station.name) throw new Error(`Expected ${station.name} was not observed`)
  }

  async function remove(placed: SiteBlock) {
    if (!placed.attempted) return
    checkDimension()
    const block = io.readBlock(placed.at)
    if (block?.name === 'air') return
    if (block?.name !== placed.name) throw new Error('Temporary block could not be identified')
    if (placed.name === 'furnace') {
      ensureCompleted(await fixture({ kind: 'drain', at: placed.at }, AbortSignal.timeout(12_000)))
    }
    await execute({ kind: 'mine', at: placed.at }, AbortSignal.timeout(10_000))
    if (io.readBlock(placed.at)?.name !== 'air') throw new Error('Server did not confirm restored air')
  }

  try {
    progress('waiting', { table: tableAt, furnace: furnaceAt })
    if (tableAt.x === furnaceAt.x && tableAt.z === furnaceAt.z) {
      throw new Error('Use different horizontal coordinates for the workstations')
    }
    while (true) {
      signal.throwIfAborted()
      const observation = io.read()
      if (observation?.dimension && observation.inventory && [table, furnace].every(({ at }) =>
        io.readBlock(at) && io.readBlock({ ...at, y: at.y - 1 }))) {
        dimension = observation.dimension
        for (const station of [table, furnace]) {
          const { at } = station
          const under = { ...at, y: at.y - 1 }
          const platform = io.readBlock(under)
          const ground = platform?.name === 'air' ? io.readBlock({ ...at, y: at.y - 2 }) : platform
          const { x, y, z } = observation.position
          if (io.readBlock(at)?.name !== 'air' || !ground || ground.name.endsWith('air')) {
            throw new Error(`Workstation site needs air above a solid support at ${JSON.stringify(at)}`)
          }
          if (platform?.name !== 'air' && !['stone', 'cobblestone', 'glass', 'stone_bricks', 'dirt'].includes(ground.name)) {
            throw new Error('Use an inert support or raise the workstation one block for a temporary glass platform')
          }
          const withinReach = (point: Position) =>
            Math.hypot(point.x + 0.5 - x, point.y + 0.5 - y - 1.62, point.z + 0.5 - z) <= 4
          if (!withinReach(at) || !withinReach(ground.position) || (Math.floor(x) === at.x && Math.floor(z) === at.z)) {
            throw new Error(`Workstation site must be within reach and outside the bot's feet at ${JSON.stringify(at)}`)
          }
          station.ground = { at: ground.position, name: ground.name }
          if (platform?.name === 'air') station.platform = { at: under, name: 'glass', attempted: false }
        }
        break
      }
      await delay(200, undefined, { signal })
    }
    progress('seeding')
    staged = true
    ensureCompleted(await fixture({ kind: 'seed' }, signal))
    progress('placing_platforms')
    for (const { platform } of [table, furnace]) {
      if (platform) await place(platform)
    }
    progress('placing_table')
    await place(table)
    progress('crafting')
    await execute({ kind: 'craft', item: 'furnace', count: 1, table: table.at }, signal)
    verifyInventory({ furnace: 1, cobblestone: 0 })
    progress('checking_craft', { furnace: 1, cobblestone: 0 })
    progress('placing_furnace')
    await place(furnace)
    progress('smelting')
    await execute({ kind: 'smelt', at: furnace.at, item: 'raw_iron', count: 1, fuel: 'coal', fuelCount: 1, output: 'iron_ingot' }, signal)
    verifyInventory({ iron_ingot: 1, raw_iron: 0, coal: 0 })
    progress('checking_smelt', { iron_ingot: 1, raw_iron: 0, coal: 0 })
  } catch (error) {
    outcome = signal.aborted || (error instanceof DOMException && error.name === 'AbortError') ? 'cancelled' : 'failed'
    failure = message(error)
  } finally {
    if (staged) {
      progress('cleaning')
      for (const station of [furnace, table]) {
        try {
          await remove(station)
          if (station.platform) await remove(station.platform)
          if ((station.attempted || station.platform?.attempted) && station.ground &&
            io.readBlock(station.ground.at)?.name !== station.ground.name) {
            throw new Error(`Original support changed at ${JSON.stringify(station.ground.at)}`)
          }
        } catch (error) {
          cleanupErrors.push(`${station.name} at ${JSON.stringify(station.at)}: ${message(error)}`)
        }
      }
      try { ensureCompleted(await fixture({ kind: 'clear' }, AbortSignal.timeout(12_000))) }
      catch (error) { cleanupErrors.push(`Inventory: ${message(error)}`) }
    }
  }
  const state = cleanupErrors.length ? 'failed' : outcome
  progress(state, { message: failure, cleanupErrors })
  return { state, message: failure, cleanupErrors }
}
