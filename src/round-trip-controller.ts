import { setTimeout as delay } from 'node:timers/promises'
import type { MinecraftIO } from './io.ts'
import type { Observation, Position } from './perception.ts'

type Phase = 'waiting' | 'moving_out' | 'checking_target' | 'returning' | 'checking_origin' | 'completed' | 'failed' | 'cancelled'
type Progress = (state: Phase, fields?: Record<string, unknown>) => void

export async function runRoundTrip(io: MinecraftIO, target: Position, signal: AbortSignal, progress: Progress) {
  let state: Phase = 'waiting'
  let origin: Position | undefined
  let dimension: string | null = null

  function at(position: Position, expected: Position) {
    return Math.floor(position.x) === expected.x && Math.floor(position.y) === expected.y && Math.floor(position.z) === expected.z
  }

  async function requirePosition(expected: Position) {
    await delay(250, undefined, { signal })
    const observation = io.read()
    if (!observation || observation.dimension !== dimension || !at(observation.position, expected)) {
      throw new Error(`Expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observation?.position ?? null)}`)
    }
    return observation.position
  }

  async function move(to: Position) {
    const status = io.read()
    if (!status || status.dimension !== dimension) throw new Error('World changed during test')
    const result = await io.execute({ kind: 'move', at: to }, signal)
    signal.throwIfAborted()
    if (result.state === 'cancelled') throw new DOMException(result.message, 'AbortError')
    if (result.state !== 'completed') throw new Error(result.message)
  }

  try {
    while (true) {
      signal.throwIfAborted()
      switch (state) {
        case 'waiting': {
          progress(state)
          let first: Observation | null = null
          // Wait for two reads in the same block before recording the return point.
          while (true) {
            const next = io.read()
            if (first && next && first.dimension === next.dimension &&
              at(first.position, blockPosition(next.position)) && io.readBlock(blockPosition(next.position))) {
              origin = blockPosition(next.position)
              dimension = next.dimension
              break
            }
            first = next
            await delay(300, undefined, { signal })
          }
          if (at(origin, target)) throw new Error('Choose a target block different from the starting block')
          state = 'moving_out'
          break
        }
        case 'moving_out':
          progress(state, { origin, dimension, target })
          await move(target)
          state = 'checking_target'
          break
        case 'checking_target':
          progress(state, { position: await requirePosition(target) })
          state = 'returning'
          break
        case 'returning':
          progress(state, { origin })
          await move(origin!)
          state = 'checking_origin'
          break
        case 'checking_origin':
          progress(state, { position: await requirePosition(origin!) })
          state = 'completed'
          break
        case 'completed':
          progress(state, { origin, target })
          return { state, origin, target } as const
      }
    }
  } catch (error) {
    const state = signal.aborted || (error instanceof DOMException && error.name === 'AbortError') ? 'cancelled' : 'failed'
    const message = error instanceof Error ? error.message : String(error)
    progress(state, { message })
    return { state, message } as const
  }
}

function blockPosition(position: Position): Position {
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
}
