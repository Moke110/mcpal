import { setTimeout as delay } from 'node:timers/promises'

export type TaskResult = { state: 'completed' | 'failed' | 'cancelled' | 'timed_out'; message: string }
export type TaskInfo = { id: number; label: string; startedAt: string }
type Work = (signal: AbortSignal) => Promise<string>
type Report = (event: string, fields: Record<string, unknown>) => void

export function createTasks(report: Report, recover: () => void, graceMs = 3000) {
  let lastId = 0
  let active: { info: TaskInfo; controller: AbortController } | undefined
  let pending: Promise<TaskResult> | undefined
  let pendingLabel: string | undefined
  let suspended = false

  function cancel(reason = 'Stopped by operator') {
    lastId++
    pendingLabel = undefined
    active?.controller.abort(new Error(reason))
  }

  function submit(label: string, work: Work, timeoutMs = 45_000, key = label, caller?: AbortSignal): Promise<TaskResult> {
    if (suspended) return Promise.resolve({ state: 'failed', message: 'Task runtime suspended' })
    if (caller?.aborted) return Promise.resolve({ state: 'cancelled', message: 'Caller cancelled the action' })
    if (!caller && pending && pendingLabel === key) return pending
    cancel('Replaced by a new task')
    const id = lastId
    pendingLabel = caller ? undefined : key
    const previous = pending
    const result = (async (): Promise<TaskResult> => {
      await previous
      if (id !== lastId || suspended || caller?.aborted) return { state: 'cancelled', message: 'Cancelled before start' }
      const info = { id, label, startedAt: new Date().toISOString() }
      const controller = new AbortController()
      const { signal } = controller
      const abortFromCaller = () => controller.abort(new Error('Caller cancelled the action'))
      active = { info, controller }
      let timedOut = false
      const deadline = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('Task deadline exceeded'))
      }, timeoutMs)
      const cleanup = new AbortController()
      const operation = Promise.resolve().then(() => {
        signal.throwIfAborted()
        return work(signal)
      }).then<TaskResult, TaskResult>(
        (message) => ({ state: 'completed', message }),
        (error: unknown) => ({ state: 'failed', message: error instanceof Error ? error.message : String(error) }),
      )
      const abort = new Promise<TaskResult>((resolve) => {
        signal.addEventListener('abort', () => {
          void delay(graceMs, undefined, { signal: cleanup.signal }).then(() => {
            suspended = true
            recover()
            resolve({ state: 'failed', message: 'Operation did not stop; session closed before starting another task' })
          }, () => {})
        }, { once: true })
      })
      caller?.addEventListener('abort', abortFromCaller, { once: true })
      report('task_started', { task: info })
      const outcome = await Promise.race([operation, abort])
      clearTimeout(deadline)
      cleanup.abort()
      caller?.removeEventListener('abort', abortFromCaller)
      active = undefined
      const final: TaskResult = signal.aborted ? {
        state: timedOut ? 'timed_out' : 'cancelled',
        message: suspended ? outcome.message : (signal.reason as Error).message,
      } : outcome
      report('task_finished', { task: info, result: final })
      return final
    })()
    pending = result
    void result.then(() => {
      if (pending === result) {
        pending = undefined
        pendingLabel = undefined
      }
    })
    return result
  }

  return { submit, cancel, status: () => active?.info ?? null, idle: () => pending }
}
