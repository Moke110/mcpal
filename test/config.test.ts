import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readConfig } from '../src/config.ts'

const env = { MC_HOST: 'localhost', MC_PORT: '49152', MC_USERNAME: 'Companion' }

test('defaults to Microsoft authentication and protocol auto detection', () => {
  assert.deepEqual(readConfig(env), {
    host: 'localhost', port: 49152, username: 'Companion', auth: 'microsoft',
    version: false, snapshotIntervalMs: 5000,
  })
})

test('uses offline authentication and a pinned version only when configured', () => {
  const config = readConfig({ ...env, MC_AUTH: 'offline', MC_VERSION: '1.21.11' })
  assert.equal(config.auth, 'offline')
  assert.equal(config.version, '1.21.11')
})

test('rejects malformed configuration before making a network connection', () => {
  for (const port of ['', '0', '1e2', '80.5', '65536']) {
    assert.throws(() => readConfig({ ...env, MC_PORT: port }), /MC_PORT/)
  }
  assert.throws(() => readConfig({ ...env, MC_HOST: 'http://localhost' }), /MC_HOST/)
  assert.throws(() => readConfig({ ...env, MC_AUTH: 'unknown' }), /MC_AUTH/)
  assert.throws(() => readConfig({ ...env, MC_USERNAME: '' }), /MC_USERNAME/)
  assert.throws(() => readConfig({ ...env, MC_SNAPSHOT_INTERVAL_MS: '10' }), /MC_SNAPSHOT_INTERVAL_MS/)
})
