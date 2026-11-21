import type { Bot } from 'mineflayer'

export async function syncInventory(bot: Bot, window: Bot['inventory']) {
  // The pinned Mineflayer version exposes the resync used by its crafting plugin.
  const client = bot as Bot & { _syncWindow?: (window: Bot['inventory']) => Promise<void> }
  if (!client._syncWindow) throw new Error('Window resync is unavailable')
  await client._syncWindow(window)
}
