import { connect } from './client.ts'
import { readConfig } from './config.ts'

function report(event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`)
}

try {
  const config = readConfig(process.env)
  const client = connect(config, report, (message) => process.stderr.write(`${message}\n`))
  const shutdown = () => client.close()
  const terminal = process.stdin.isTTY || process.argv.includes('--interactive')
    ? createInterface({ input: process.stdin, terminal: false })
    : undefined
  terminal?.on('line', (text) => {
    const line = text.trim()
    if (line === 'status') {
      const observation = client.io.read()
      report('status', { ready: observation !== null, observation })
    } else if (line === 'quit') shutdown()
    else if (line && client.command) client.command(line)
    else if (line) report('command_reply', { message: 'Commands: status, quit' })
  })
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  const { requested, pendingLogin } = await client.closed
  terminal?.close()
  process.removeListener('SIGINT', shutdown)
  process.removeListener('SIGTERM', shutdown)
  process.exitCode = requested ? 0 : 1
  if (pendingLogin) {
    // Flush the last JSON record before ending a pending device-code flow.
    process.stdout.write('', () => process.exit(process.exitCode))
  }
} catch (error) {
  report('startup_error', { message: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
}
import { createInterface } from 'node:readline'
