import { resolve } from 'node:path'
import mineflayer from 'mineflayer'
import type { Config } from './config.ts'
import { createControls, type TrustedMinecraftChat } from './controls.ts'
import type { MinecraftIO } from './io.ts'
import { readBlock, readObservation } from './perception.ts'

type Report = (event: string, fields?: Record<string, unknown>) => void

export function connect(config: Config, report: Report, onAuthPrompt: (message: string) => void,
  { workstationTest = false, profilesFolder = resolve('.runtime', 'profiles'), onTrustedChat }:
    { workstationTest?: boolean; profilesFolder?: string; onTrustedChat?: (message: TrustedMinecraftChat) => void } = {}) {
  let stopping = false
  report('connecting', { host: config.host, port: config.port, auth: config.auth, version: config.version || 'auto' })
  const bot = mineflayer.createBot({
    host: config.host, port: config.port, username: config.username,
    auth: config.auth, version: config.version || undefined,
    profilesFolder,
    physicsEnabled: config.control !== undefined, respawn: false, hideErrors: true, logErrors: false,
    onMsaCode: ({ message }) => { if (!stopping) onAuthPrompt(message) },
  })
  let spawned = false
  let positioned = false
  let inventoryReceived = false
  const currentEntities = new Set<number>()
  const isCurrentEntity = (id: number) => currentEntities.has(id)
  let ended = false
  let interval: NodeJS.Timeout | undefined
  let stopReason: string | undefined
  let controls: ReturnType<typeof createControls> | undefined
  const transport = bot._client
  transport.addListener('connect', () => {
    if (stopping) transport.socket.destroy()
  })

  const startup = setTimeout(() => {
    report('error', { message: 'Timed out waiting for login and initial player state' })
    close('startupTimeout')
  }, 300_000)

  const { promise: closed, resolve: finish } = Promise.withResolvers<{
    reason: string; requested: boolean; pendingLogin: boolean
  }>()
  bot.once('end', (reason) => complete(reason, false))

  async function complete(reason: string, pendingLogin: boolean) {
    if (ended) return
    ended = true
    clearTimeout(startup)
    clearInterval(interval)
    const requested = stopReason === 'shutdown'
    try { await controls?.close() }
    catch (error) { report('cleanup_error', { message: error instanceof Error ? error.message : String(error) }) }
    report('disconnected', { reason, requested })
    finish({ reason, requested, pendingLogin })
  }

  function close(reason = 'shutdown') {
    if (ended || stopping) return
    stopping = true
    stopReason = reason
    controls?.cancel('Session closing')
    clearTimeout(startup)
    clearInterval(interval)
    if (bot._client.socket) {
      bot.end(reason)
    } else {
      // Authentication can still be polling before the game socket exists.
      complete(reason, true)
    }
  }

  function ready() {
    return !stopping && !ended && spawned && positioned
  }

  function getStatus() {
    return ready()
      ? readObservation(bot, inventoryReceived, controls?.status(), isCurrentEntity)
      : null
  }

  function publish() {
    const observation = getStatus()
    if (observation) report('snapshot', { observation })
  }

  function observeWhenReady() {
    if (stopping || ended || !spawned || !positioned || interval) return
    clearTimeout(startup)
    report('spawned')
    setImmediate(publish)
    interval = setInterval(publish, config.snapshotIntervalMs)
  }

  bot.once('login', () => report('login', { username: transport.username, version: bot.version }))
  bot.on('spawn', () => {
    spawned = true
    observeWhenReady()
  })
  bot.on('forcedMove', () => {
    positioned = true
    observeWhenReady()
  })
  bot.on('entitySpawn', entity => { currentEntities.add(entity.id) })
  bot.on('entityGone', entity => { currentEntities.delete(entity.id) })
  bot.on('respawn', () => {
    spawned = false
    positioned = false
    inventoryReceived = false
    currentEntities.clear()
    clearInterval(interval)
    interval = undefined
    controls?.cancel('Dimension changed or player respawned')
    report('world_unavailable')
  })
  transport.on('window_items', (packet: { windowId: number }) => {
    if (packet.windowId === 0) inventoryReceived = true
  })
  bot.on('chat', (username, message) => report('chat', { username, message }))
  bot.on('death', () => {
    controls?.cancel('Player died')
    report('death')
  })
  bot.on('kicked', (reason, loggedIn) => report('kicked', { reason, loggedIn }))
  bot.on('error', (error) => {
    if (stopping || ended) return
    report('error', { message: error.message })
    close('connectionError')
  })

  if (config.control) {
    try {
      controls = createControls(bot, { ...config, control: config.control },
        () => bot.health === 0 ? null : getStatus(), report, () => {
          close('operationCleanupTimeout')
          transport.socket?.destroy()
        }, workstationTest, isCurrentEntity, onTrustedChat)
    } catch (error) {
      report('error', { message: error instanceof Error ? error.message : String(error) })
      close('controlSetupFailed')
    }
  }

  const io: MinecraftIO = {
    read: getStatus,
    readBlock: at => ready() ? readBlock(bot, at) : null,
    execute: (action, signal) => controls?.execute(action, signal)
      ?? Promise.resolve({ state: 'failed', message: 'Control is disabled' }),
    stop: () => controls?.cancel(),
  }
  const chat = { send: (text: string) => controls?.reply(text) ?? false }
  return { closed, close, getStatus, io, chat, fixture: controls?.fixture, command: controls?.terminal }
}
