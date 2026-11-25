import type { Bot } from 'mineflayer'
import type { TaskInfo } from './tasks.ts'

export interface Position { x: number; y: number; z: number }
export interface BlockObservation { position: Position; name: string; stateId: number }
export interface NearbyEntity {
  id: number
  type: string
  name: string | null
  username: string | null
  position: Position
  distance: number
}

export interface Observation {
  schemaVersion: 1
  systemMessages?: string[]
  username: string
  connection: 'spawned'
  version: string
  dimension: string | null
  position: Position
  orientation: { yawRadians: number; pitchRadians: number }
  health: number | null
  food: number | null
  currentTask: TaskInfo | null
  inventory: { slot: number; name: string; count: number }[] | null
  nearby: { radius: number; players: NearbyEntity[]; entities: NearbyEntity[] }
  blocks: { position: Position; name: string | null }[]
}

export function readObservation(bot: Bot, inventoryReceived: boolean, currentTask: TaskInfo | null = null,
  isCurrentEntity: (id: number) => boolean = () => true): Observation {
  const { position, yaw, pitch } = bot.entity
  const radius = 32
  const nearby = { radius, players: [] as NearbyEntity[], entities: [] as NearbyEntity[] }
  for (const entity of Object.values(bot.entities)) {
    if (entity.id === bot.entity.id || !entity.isValid || !isCurrentEntity(entity.id)) continue
    const distance = position.distanceTo(entity.position)
    if (!Number.isFinite(distance) || distance > radius) continue
    const target = entity.type === 'player' ? nearby.players : nearby.entities
    target.push({
      id: entity.id, type: entity.type, name: entity.name ?? null,
      username: entity.username ?? null, position: coordinates(entity.position), distance,
    })
  }

  return {
    schemaVersion: 1,
    username: bot.username,
    connection: 'spawned',
    version: bot.version,
    dimension: bot.game.dimension ?? null,
    position: coordinates(position),
    orientation: { yawRadians: yaw, pitchRadians: pitch },
    health: Number.isFinite(bot.health) ? bot.health : null,
    food: Number.isFinite(bot.food) ? bot.food : null,
    currentTask,
    inventory: inventoryReceived
      ? bot.inventory.slots.flatMap((item, slot) => item ? [{ slot, name: item.name, count: item.count }] : [])
      : null,
    nearby,
    blocks: [-1, 0, 1].map((dy) => {
      const point = position.floored().offset(0, dy, 0)
      return { position: coordinates(point), name: bot.blockAt(point, false)?.name ?? null }
    }),
  }
}

function coordinates({ x, y, z }: Position): Position {
  return { x, y, z }
}

export function readBlock(bot: Bot, at: Position): BlockObservation | null {
  if (![at.x, at.y, at.z].every(Number.isSafeInteger)) return null
  const from = bot.entity.position
  const block = bot.blockAt(from.offset(at.x - from.x, at.y - from.y, at.z - from.z), false)
  return block ? { position: coordinates(at), name: block.name, stateId: block.stateId } : null
}
