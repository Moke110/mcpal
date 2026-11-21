import { username as playerName } from './actions.ts'

export interface Config {
  host: string
  port: number
  username: string
  auth: 'microsoft' | 'offline'
  version: string | false
  snapshotIntervalMs: number
  control?: {
    players: ReadonlySet<string>
  }
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const host = env.MC_HOST?.trim()
  if (!host || /[\s/\\]/u.test(host)) throw new Error('Set MC_HOST to a hostname or IP address')

  const port = integer(env.MC_PORT, 'MC_PORT', 1, 65535)
  const auth = env.MC_AUTH?.trim() || 'microsoft'
  if (auth !== 'microsoft' && auth !== 'offline') {
    throw new Error('MC_AUTH must be microsoft or offline')
  }

  const username = env.MC_USERNAME?.trim()
  if (!username) throw new Error('Set MC_USERNAME to the login account or offline player name')
  if (auth === 'offline' && !/^[a-zA-Z0-9_]{1,16}$/u.test(username)) {
    throw new Error('Offline player names must contain 1–16 letters, digits or underscores')
  }

  const version = env.MC_VERSION?.trim() || 'auto'
  const players = new Set((env.MC_AUTHORIZED_PLAYERS ?? '').split(',').map(name => name.trim())
    .filter(Boolean).map(name => playerName(name).toLowerCase()))
  const controlEnabled = enabled(env.MC_CONTROL, 'MC_CONTROL')
  if (controlEnabled && auth === 'offline' && !enabled(env.MC_ALLOW_OFFLINE_CONTROL, 'MC_ALLOW_OFFLINE_CONTROL')) {
    throw new Error('Offline control requires MC_ALLOW_OFFLINE_CONTROL=true in an isolated world')
  }
  return {
    host, port, username, auth, version: version === 'auto' ? false : version,
    snapshotIntervalMs: integer(env.MC_SNAPSHOT_INTERVAL_MS ?? '5000', 'MC_SNAPSHOT_INTERVAL_MS', 1000, 60000),
    ...(controlEnabled ? { control: { players } } : {}),
  }
}

function enabled(raw: string | undefined, key: string) {
  const value = raw?.trim() || 'false'
  if (value !== 'false' && value !== 'true') throw new Error(`${key} must be true or false`)
  return value === 'true'
}

function integer(raw: string | undefined, key: string, min: number, max: number): number {
  const value = Number(raw?.trim())
  if (!/^\d+$/u.test(raw?.trim() ?? '') || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`)
  }
  return value
}
