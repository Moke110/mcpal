import type { Bot } from 'mineflayer'
import prismarineItem from 'prismarine-item'
import type { Item } from 'prismarine-item'
import { syncInventory } from './inventory-sync.ts'
import type { Position } from './perception.ts'
import type { TaskResult } from './tasks.ts'

export type FixtureAction = { kind: 'seed' | 'clear' } | { kind: 'drain'; at: Position }
export type RunFixture = (action: FixtureAction, signal: AbortSignal) => Promise<TaskResult>

const supplies = [
  { slot: 36, name: 'crafting_table', count: 1 },
  { slot: 37, name: 'cobblestone', count: 8 },
  { slot: 38, name: 'raw_iron', count: 1 },
  { slot: 39, name: 'coal', count: 1 },
  { slot: 40, name: 'glass', count: 2 },
]
const testItems = new Set([...supplies.map(item => item.name), 'furnace', 'iron_ingot'])

export function createWorkstationFixture(bot: Bot) {
  let started = false
  const loadItem = prismarineItem as unknown as (registry: Bot['registry']) => typeof Item

  return async (action: FixtureAction, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    if (bot.game.gameMode !== 'creative') throw new Error('Workstation fixture requires Creative mode')
    switch (action.kind) {
      case 'seed': {
        await syncInventory(bot, bot.inventory)
        signal.throwIfAborted()
        if (started || bot.inventory.slots.some(Boolean) || bot.inventory.selectedItem) {
          throw new Error('Workstation fixture requires an empty starting inventory')
        }
        started = true
        const Item = loadItem(bot.registry)
        for (const { slot, name, count } of supplies) {
          signal.throwIfAborted()
          await bot.creative.setInventorySlot(slot, new Item(bot.registry.itemsByName[name]!.id, count))
        }
        await syncInventory(bot, bot.inventory)
        if (supplies.some(({ slot, name, count }) => bot.inventory.slots[slot]?.name !== name ||
          bot.inventory.slots[slot]?.count !== count)) throw new Error('Server did not confirm test supplies')
        return 'Server confirmed test supplies'
      }
      case 'drain': {
        if (!started) throw new Error('No workstation fixture was staged')
        const from = bot.entity.position
        const { x, y, z } = action.at
        const block = bot.blockAt(from.offset(x - from.x, y - from.y, z - from.z))
        if (block?.name !== 'furnace') throw new Error('Temporary furnace is unavailable')
        const furnace = await bot.openFurnace(block)
        try {
          signal.throwIfAborted()
          const contents = () => [furnace.inputItem(), furnace.fuelItem(), furnace.outputItem()].filter(Boolean)
          if (contents().some(item => !['raw_iron', 'coal', 'iron_ingot'].includes(item.name))) {
            throw new Error('Temporary furnace contains items outside this test')
          }
          if (furnace.inputItem()) await furnace.takeInput()
          signal.throwIfAborted()
          if (furnace.fuelItem()) await furnace.takeFuel()
          signal.throwIfAborted()
          if (furnace.outputItem()) await furnace.takeOutput()
          await syncInventory(bot, furnace)
          if (contents().length) throw new Error('Server did not confirm an empty furnace')
          return 'Server confirmed empty furnace'
        } finally {
          if (bot.currentWindow === furnace) await furnace.close()
        }
      }
      case 'clear': {
        if (!started) return 'No test items to clear'
        await syncInventory(bot, bot.inventory)
        signal.throwIfAborted()
        const items = bot.inventory.slots.filter(item => item && testItems.has(item.name))
        for (const item of items) {
          signal.throwIfAborted()
          await bot.creative.clearSlot(item!.slot)
        }
        await syncInventory(bot, bot.inventory)
        if (bot.inventory.slots.some(Boolean) || bot.inventory.selectedItem) {
          throw new Error('Server did not confirm an empty inventory; unrelated items were preserved')
        }
        started = false
        return 'Server confirmed empty inventory'
      }
    }
  }
}
