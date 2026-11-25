import { parseAction } from './actions.ts'
import { connect } from './client.ts'
import { readConfig } from './config.ts'
import { runRoundTrip } from './round-trip-controller.ts'
import { runWorkstations } from './workstation-controller.ts'

function report(event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`)
}

try {
  const config = readConfig(process.env)
  if (!config.control) throw new Error('Set MC_CONTROL=true to run the test controller')
  const args = process.argv.slice(2)
  const workstations = args[0] === 'workstations'
  const coordinates = workstations ? args.slice(1) : args
  if (coordinates.length !== (workstations ? 6 : 3) || coordinates.some(value => !/^-?\d+$/u.test(value))) {
    throw new Error('Usage: npm run controller -- <x> <y> <z> | workstations <tableX> <tableY> <tableZ> <furnaceX> <furnaceY> <furnaceZ>')
  }
  const [x, y, z, fx, fy, fz] = coordinates.map(Number)
  const target = parseAction({ kind: 'move', at: { x, y, z } })
  const furnace = workstations ? parseAction({ kind: 'move', at: { x: fx, y: fy, z: fz } }) : undefined
  if (target.kind !== 'move' || (furnace && furnace.kind !== 'move')) throw new Error('Expected block coordinates')
  const client = connect(config, report, message => process.stderr.write(`${message}\n`), { workstationTest: workstations })
  const interruption = new AbortController()
  const interrupt = () => interruption.abort(new Error('Controller interrupted'))
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  void client.closed.then(({ reason }) => interruption.abort(new Error(`Disconnected: ${reason}`)))
  try {
    const signal = AbortSignal.any([interruption.signal, AbortSignal.timeout(90_000)])
    const progress = (state: string, fields?: Record<string, unknown>) => report('controller_state', { state, ...fields })
    if (furnace && !client.fixture) throw new Error('Workstation fixture is unavailable')
    const result = furnace && client.fixture
      ? await runWorkstations(client.io, client.fixture, target.at, furnace.at, signal, progress)
      : await runRoundTrip(client.io, target.at, signal, progress)
    process.exitCode = result.state === 'completed' ? 0 : 1
  } finally {
    client.close()
    const { pendingLogin } = await client.closed
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    if (pendingLogin) process.stdout.write('', () => process.exit(process.exitCode))
  }
} catch (error) {
  report('controller_error', { message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
}
