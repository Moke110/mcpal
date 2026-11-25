import type { Bot } from 'mineflayer'
import { parseAction, type Action } from './actions.ts'
import type { Config } from './config.ts'
import type { Observation } from './perception.ts'
import { createSkills } from './skills.ts'
import { createTasks, type TaskResult } from './tasks.ts'
import { createWorkstationFixture, type RunFixture } from './workstation-fixture.ts'

type Report = (event: string, fields?: Record<string, unknown>) => void
type Command = { kind: 'follow' | 'come' | 'stop' | 'status' | 'help' | 'act'; arg: string }
export type TrustedMinecraftChat = Readonly<{ player: string; text: string }>

export function parseCommand(message: string): Command | null {
  if (!message.startsWith('!')) return null
  const [, name, arg = ''] = /^!(\S+)(?:\s+([\s\S]*))?$/u.exec(message.trim()) ?? []
  switch (name) {
    case 'follow': case 'come': case 'stop': case 'status': case 'help':
      if (arg) throw new Error(`Usage: !${name}`)
      return { kind: name, arg }
    case 'act':
      if (!arg) throw new Error(`Usage: !${name} <argument>`)
      return { kind: name, arg }
    default:
      throw new Error('Unknown command. Use !help')
  }
}

export function authorizedPlayer(bot: Pick<Bot, 'players' | 'username'>, config: Config, sender: string, verified?: boolean) {
  if (config.auth === 'microsoft' && verified !== true) return undefined
  const player = Object.values(bot.players).find(entry => entry.uuid === sender)
  if (!player) return undefined
  const name = player.username.toLowerCase()
  if (name !== bot.username.toLowerCase() && config.control?.players.has(name)) return player.username
  return undefined
}

export function createControls(bot: Bot, config: Config & { control: NonNullable<Config['control']> },
  observe: () => Observation | null, report: Report, recover: () => void, workstationTest: boolean,
  isCurrentEntity: (id: number) => boolean, onTrustedChat?: (message: TrustedMinecraftChat) => void) {
  const skills = createSkills(bot, isCurrentEntity)
  const tasks = createTasks(report, recover)
  const reported = new Set<Promise<TaskResult>>()
  let closing = false
  const fixtureWork = workstationTest ? createWorkstationFixture(bot) : undefined
  const fixture: RunFixture | undefined = fixtureWork && ((action, signal) => {
    if (closing || !observe()) return Promise.resolve({ state: 'failed', message: 'Game state is not ready' })
    return tasks.submit(`fixture_${action.kind}`, taskSignal => fixtureWork(action, taskSignal), 12_000, undefined, signal)
  })

  function reply(message: string) {
    if (closing || !observe()) return false
    const safe = message.replace(/[\p{Cc}§]/gu, ' ').trim().slice(0, 200)
    if (!safe) return false
    try { bot.chat(`[Companion] ${safe}`); return true }
    catch { report('chat_reply_failed'); return false }
  }

  function snapshot() {
    const observation = observe()
    if (!observation) throw new Error('Game state is not ready')
    return observation
  }

  function execute(value: Action, signal?: AbortSignal, owner = '@controller'): Promise<TaskResult> {
    if (closing || !observe()) return Promise.resolve({ state: 'failed', message: 'Game state is not ready' })
    let action: Action
    try { action = parseAction(value) }
    catch (error) {
      return Promise.resolve({ state: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
    const timeout = action.kind === 'smelt' ? 900_000 : action.kind === 'follow' ? 1_800_000 : undefined
    return tasks.submit(action.kind, taskSignal => skills.execute(action, taskSignal), timeout,
      `${owner}:${JSON.stringify(action)}`, signal)
  }

  function runAction(owner: string, send: (message: string) => void, action: Action) {
    const result = execute(action, undefined, owner)
    if (reported.has(result)) return
    reported.add(result)
    void result.then(outcome => {
      reported.delete(result)
      if (outcome.state !== 'cancelled' && !closing) send(`${action.kind}: ${outcome.message}`)
    })
  }

  function handle(player: string, message: string, send: (message: string) => void) {
    const command = parseCommand(message)
    if (!command) return
    report('command_received', { player, command: command.kind })
    const owner = player.toLowerCase()
    switch (command.kind) {
      case 'help':
        send('!follow !stop !come !status !help !act <JSON>')
        return
      case 'stop':
        tasks.cancel()
        send('Stop requested')
        return
      case 'status': {
        const status = snapshot()
        const { x, y, z } = status.position
        send(`${status.dimension ?? '?'} (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) HP ${status.health ?? '?'} food ${status.food ?? '?'} task ${status.currentTask?.label ?? 'idle'}`)
        return
      }
      case 'follow':
      case 'come':
        if (player === '@terminal') throw new Error(`Use act {"kind":"${command.kind}","player":"PlayerName"}`)
        runAction(owner, send, { kind: command.kind, player })
        return
      case 'act':
        runAction(owner, send, parseAction(JSON.parse(command.arg)))
        return
    }
  }

  function dispatch(player: string, message: string, send: (text: string) => void) {
    try { handle(player, message, send) }
    catch (error) {
      const reason = error instanceof SyntaxError ? 'Invalid JSON' : error instanceof Error ? error.message : String(error)
      report('command_rejected', { player, message: reason })
      send(reason)
    }
  }

  bot._client.on('playerChat', ({ sender, plainMessage, verified }) => {
    if (closing || !observe() || typeof plainMessage !== 'string' ||
      (!onTrustedChat && !plainMessage.startsWith('!'))) return
    const player = authorizedPlayer(bot, config, sender, verified)
    if (!player) return
    if (onTrustedChat) {
      onTrustedChat({ player, text: plainMessage })
      return
    }
    dispatch(player, plainMessage, reply)
  })

  return {
    execute,
    reply,
    fixture,
    status: tasks.status,
    cancel: tasks.cancel,
    terminal: (line: string) => {
      if (!closing) dispatch('@terminal', `!${line}`, message => report('command_reply', { message }))
    },
    async close() {
      closing = true
      tasks.cancel('Session closed')
      await tasks.idle()
    },
  }
}
