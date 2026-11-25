import type { Action } from './actions.ts'
import type { BlockObservation, Observation, Position } from './perception.ts'
import type { TaskResult } from './tasks.ts'

export interface MinecraftIO {
  read(): Observation | null
  readBlock(at: Position): BlockObservation | null
  execute(action: Action, signal?: AbortSignal): Promise<TaskResult>
  stop(): void
}
