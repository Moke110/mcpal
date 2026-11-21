import { setTimeout as delay } from 'node:timers/promises'
import type { Bot } from 'mineflayer'
import pathfinderPlugin from 'mineflayer-pathfinder'
import type { Action } from './actions.ts'
import type { Position } from './perception.ts'
import { syncInventory } from './inventory-sync.ts'

const { goals, Movements, pathfinder } = pathfinderPlugin

export function createSkills(bot: Bot, isCurrentEntity: (id: number) => boolean) {
  bot.loadPlugin(pathfinder)
  let configured = false

  function vector(at: Position) {
    const from = bot.entity.position
    return from.offset(at.x - from.x, at.y - from.y, at.z - from.z)
  }

  function itemType(name: string) {
    const item = bot.registry.itemsByName[name]
    if (!item) throw new Error(`Unknown item: ${name}`)
    return item.id
  }

  function itemCount(id: number) {
    return bot.inventory.items().reduce((total, item) => total + (item.type === id ? item.count : 0), 0)
  }

  function blockAt(at: Position) {
    const point = vector(at)
    if (point.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) > 4.5) {
      throw new Error('Block is outside interaction range')
    }
    const block = bot.blockAt(point)
    if (!block) throw new Error('Block has not been loaded')
    return block
  }

  function playerEntity(player: string) {
    const entity = bot.players[player]?.entity
    return entity?.isValid && entity !== bot.entity && isCurrentEntity(entity.id) ? entity : undefined
  }

  async function mine(at: Position, signal: AbortSignal) {
    const block = blockAt(at)
    if (!bot.canDigBlock(block)) throw new Error('Block cannot be mined from here')
    const tool = bot.pathfinder.bestHarvestTool(block)
    if (tool) await bot.equip(tool, 'hand')
    signal.throwIfAborted()
    let confirmed = false
    const onBlock = ({ location, type }: { location: Position; type: number }) => {
      if (location.x === at.x && location.y === at.y && location.z === at.z && type !== block.stateId) confirmed = true
    }
    const onSection = ({ chunkCoordinates, records }: { chunkCoordinates?: Position; records: number[] }) => {
      if (!chunkCoordinates || chunkCoordinates.x !== (at.x >> 4) ||
        chunkCoordinates.y !== (at.y >> 4) || chunkCoordinates.z !== (at.z >> 4)) return
      const local = ((at.x & 15) << 8) | ((at.z & 15) << 4) | (at.y & 15)
      if (records.some(entry => (entry & 4095) === local && (entry >> 12) !== block.stateId)) confirmed = true
    }
    bot._client.on('block_change', onBlock)
    bot._client.on('multi_block_change', onSection)
    try {
      await bot.dig(block, true, 'raycast')
      for (let tries = 0; !confirmed && tries < 20; tries++) await delay(100, undefined, { signal })
      if (!confirmed || blockAt(at).stateId === block.stateId) throw new Error('Server did not confirm block removal')
      return `Mined ${block.name}`
    } finally {
      bot._client.off('block_change', onBlock)
      bot._client.off('multi_block_change', onSection)
    }
  }

  async function move(at: Position, radius: number, signal: AbortSignal) {
    if (vector(at).distanceTo(bot.entity.position) > 64) throw new Error('Destination is beyond 64 blocks')
    if (!bot.blockAt(vector(at), false)) throw new Error('Destination is in an unloaded chunk')
    const goal = new goals.GoalNear(at.x, at.y, at.z, radius)
    const arrived = () => bot.entity.position.floored().distanceTo(vector(at)) <= radius
    for (let attempt = 0; !arrived(); attempt++) {
      signal.throwIfAborted()
      try {
        await bot.pathfinder.goto(goal)
      } catch (error) {
        if (attempt || signal.aborted || !(error instanceof Error) || error.name !== 'Timeout') throw error
        await delay(350, undefined, { signal })
        continue
      }
      if (!arrived()) throw new Error('Path ended before reaching the destination')
    }
    return 'Reached destination'
  }

  async function follow(player: string, signal: AbortSignal) {
    let entity = playerEntity(player)
    if (!entity) throw new Error('Player is outside tracking range')
    let missingSince: number | undefined
    let blockedSince: number | undefined
    const onPath = ({ status }: { status: string }) => {
      if (status === 'noPath' || status === 'timeout') blockedSince ??= Date.now()
      else blockedSince = undefined
    }
    bot.on('path_update', onPath)
    try {
      bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
      while (!signal.aborted) {
        await delay(250, undefined, { signal })
        const next = playerEntity(player)
        if (!next) {
          if (missingSince === undefined) {
            missingSince = Date.now()
            bot.pathfinder.setGoal(null)
          }
          if (Date.now() - missingSince > 8000) throw new Error('Lost sight of the player')
          continue
        }
        if (missingSince !== undefined || next !== entity) {
          entity = next
          missingSince = undefined
          blockedSince = undefined
          bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
        }
        if (blockedSince !== undefined && Date.now() - blockedSince > 8000) throw new Error('Unable to follow: no route')
      }
      signal.throwIfAborted()
      return 'Follow ended'
    } finally {
      bot.off('path_update', onPath)
    }
  }

  async function execute(action: Action, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (!configured) {
      const movements = new Movements(bot)
      movements.canDig = false
      movements.allow1by1towers = false
      movements.allowParkour = false
      movements.scafoldingBlocks = []
      bot.pathfinder.setMovements(movements)
      Object.assign(bot.pathfinder, { searchRadius: 64 })
      configured = true
    }
    const stop = () => {
      bot.pathfinder.setGoal(null)
      bot.clearControlStates()
      if (bot.targetDigBlock) bot.stopDigging()
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      switch (action.kind) {
        case 'move':
          return await move(action.at, 0, signal)
        case 'come': {
          const target = playerEntity(action.player)
          if (!target) throw new Error('Player is outside tracking range')
          return await move(target.position.floored(), 2, signal)
        }
        case 'follow':
          return await follow(action.player, signal)
        case 'mine':
          return await mine(action.at, signal)
        case 'place': {
          const target = blockAt(action.at)
          if (!['air', 'cave_air', 'void_air'].includes(target.name)) throw new Error('Target block is occupied')
          const reference = blockAt(action.against)
          const face = vector(action.at).minus(reference.position)
          if (Math.abs(face.x) + Math.abs(face.y) + Math.abs(face.z) !== 1) throw new Error('Blocks must share a face')
          if (!bot.registry.blocksByName[action.item]) throw new Error('Expected a placeable item with the same block name')
          const item = bot.inventory.items().find(({ type }) => type === itemType(action.item))
          if (!item) throw new Error('Item is not in inventory')
          await bot.equip(item, 'hand')
          signal.throwIfAborted()
          await bot.placeBlock(reference, face)
          if (blockAt(action.at).name !== action.item) throw new Error('Expected block placement was not observed')
          return `Placed ${action.item}`
        }
        case 'interact': {
          const block = blockAt(action.at)
          if (!/(?:_door|_trapdoor|_button|_fence_gate|^lever)$/u.test(block.name)) {
            throw new Error('Expected a door, gate, trapdoor, button or lever')
          }
          await bot.activateBlock(block)
          for (let tries = 0; tries < 10; tries++) {
            if (blockAt(action.at).stateId !== block.stateId) return `Activated ${block.name}`
            await delay(100, undefined, { signal })
          }
          throw new Error('Block state change was not observed')
        }
        case 'use': {
          const entity = bot.entities[action.entityId]
          if (!entity?.isValid || entity === bot.entity || entity.position.distanceTo(bot.entity.position) > 3) {
            throw new Error('Entity is outside interaction range')
          }
          const before = bot.currentWindow
          await bot.activateEntity(entity)
          for (let tries = 0; tries < 10; tries++) {
            if (bot.currentWindow && bot.currentWindow !== before) {
              await bot.closeWindow(bot.currentWindow)
              return 'Entity interaction opened a window'
            }
            await delay(100, undefined, { signal })
          }
          throw new Error('Entity interaction sent but no window opened to confirm its effect')
        }
        case 'craft': {
          const type = itemType(action.item)
          const table = action.table ? blockAt(action.table) : null
          if (table && table.name !== 'crafting_table') throw new Error('Expected a crafting table')
          const recipe = bot.recipesFor(type, null, action.count, table)[0]
          if (!recipe) throw new Error('No craftable recipe for requested quantity')
          const runs = Math.ceil(action.count / recipe.result.count)
          const before = itemCount(type)
          await bot.craft(recipe, runs, table ?? undefined)
          signal.throwIfAborted()
          await syncInventory(bot, bot.inventory)
          if (itemCount(type) < before + action.count) throw new Error('Crafted items were not observed in inventory')
          return `Crafted ${runs * recipe.result.count} ${action.item}`
        }
        case 'deposit':
        case 'withdraw': {
          const block = blockAt(action.at)
          if (!/(?:^chest$|^trapped_chest$|^barrel$|(?:^|_)shulker_box$)/u.test(block.name)) {
            throw new Error('Expected a chest, barrel or shulker box')
          }
          const type = itemType(action.item)
          const window = await bot.openContainer(block)
          try {
            signal.throwIfAborted()
            const counts = () => window.slots.slice(window.inventoryStart, window.inventoryEnd)
              .reduce((total, item) => total + (item?.type === type ? item.count : 0), 0)
            const before = counts()
            const containerCount = () => window.slots.slice(0, window.inventoryStart)
              .reduce((total, item) => total + (item?.type === type ? item.count : 0), 0)
            const beforeContainer = containerCount()
            if ((action.kind === 'deposit' ? before : beforeContainer) < action.count) throw new Error('Insufficient items to transfer')
            if (action.kind === 'deposit') await window.deposit(type, null, action.count)
            else await window.withdraw(type, null, action.count)
            signal.throwIfAborted()
            await syncInventory(bot, window)
            const delta = action.kind === 'deposit' ? -action.count : action.count
            if (counts() !== before + delta || containerCount() !== beforeContainer - delta) {
              throw new Error('Expected inventory transfer was not observed')
            }
          } finally {
            if (bot.currentWindow === window) await window.close()
          }
          return `${action.kind}: ${action.count} ${action.item}`
        }
        case 'smelt': {
          const block = blockAt(action.at)
          if (!['furnace', 'blast_furnace', 'smoker'].includes(block.name)) throw new Error('Expected a furnace')
          const input = itemType(action.item)
          const fuel = itemType(action.fuel)
          const output = itemType(action.output)
          if (itemCount(input) < action.count + (input === fuel ? action.fuelCount : 0) || itemCount(fuel) < action.fuelCount) {
            throw new Error('Insufficient furnace input or fuel')
          }
          const window = await bot.openFurnace(block)
          try {
            signal.throwIfAborted()
            if (window.inputItem() || window.fuelItem() || window.outputItem()) throw new Error('Furnace slots must be empty')
            await window.putInput(input, null, action.count)
            signal.throwIfAborted()
            await window.putFuel(fuel, null, action.fuelCount)
            while (true) {
              signal.throwIfAborted()
              const result = window.outputItem()
              if (result && result.type !== output) throw new Error('Unexpected furnace output')
              if (result && result.count >= action.count) {
                const counts = () => window.slots.slice(window.inventoryStart, window.inventoryEnd)
                  .reduce((total, item) => total + (item?.type === output ? item.count : 0), 0)
                const before = counts()
                const taken = await window.takeOutput()
                signal.throwIfAborted()
                await syncInventory(bot, window)
                if (taken.type !== output || taken.count < action.count || counts() !== before + taken.count) {
                  throw new Error('Furnace output transfer was incomplete')
                }
                return `Collected ${taken.count} ${action.output}`
              }
              await delay(500, undefined, { signal })
            }
          } finally {
            if (bot.currentWindow === window) await window.close()
          }
        }
      }
    } finally {
      signal.removeEventListener('abort', stop)
      stop()
    }
  }

  return { execute }
}
