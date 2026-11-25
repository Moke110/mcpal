import type { Position } from './perception.ts'

export type Action =
  | { kind: 'move' | 'mine' | 'interact'; at: Position }
  | { kind: 'follow' | 'come'; player: string }
  | { kind: 'place'; at: Position; against: Position; item: string }
  | { kind: 'craft'; item: string; count: number; table?: Position }
  | { kind: 'deposit' | 'withdraw'; at: Position; item: string; count: number }
  | { kind: 'smelt'; at: Position; item: string; count: number; fuel: string; fuelCount: number; output: string }
  | { kind: 'use'; entityId: number }

export function parseAction(value: unknown): Action {
  const action = record(value)
  switch (action.kind) {
    case 'move':
    case 'mine':
    case 'interact':
      return { kind: action.kind, at: position(action.at) }
    case 'follow':
    case 'come':
      return { kind: action.kind, player: username(action.player) }
    case 'place':
      return { kind: action.kind, at: position(action.at), against: position(action.against), item: itemName(action.item) }
    case 'craft':
      return { kind: action.kind, item: itemName(action.item), count: count(action.count),
        ...(action.table === undefined ? {} : { table: position(action.table) }) }
    case 'deposit':
    case 'withdraw':
      return { kind: action.kind, at: position(action.at), item: itemName(action.item), count: count(action.count) }
    case 'smelt':
      return { kind: action.kind, at: position(action.at), item: itemName(action.item), count: count(action.count),
        fuel: itemName(action.fuel), fuelCount: count(action.fuelCount), output: itemName(action.output) }
    case 'use':
      return { kind: action.kind, entityId: integer(action.entityId, 0, 2_147_483_647) }
    default:
      throw new Error('Unknown action kind')
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || !value || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}

export function username(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_]{1,16}$/u.test(value)) throw new Error('Invalid player name')
  return value
}

function itemName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9_]{1,100}$/u.test(value)) throw new Error('Invalid item name')
  return value
}

function position(value: unknown): Position {
  const { x, y, z } = record(value)
  return { x: integer(x, -30_000_000, 30_000_000), y: integer(y, -2048, 2048), z: integer(z, -30_000_000, 30_000_000) }
}

function count(value: unknown) {
  return integer(value, 1, 64)
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected an integer from ${min} to ${max}`)
  }
  return value
}
