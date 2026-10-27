import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MAX_MESSAGE_BYTES,
  compatibilityOf,
  disabledByEnv,
  envFlagOn,
  hapiPeerToolsDisabledByEnv,
  messageBudgetOf,
} from '../config.js'

test('environment flags accept only trimmed, case-insensitive string values 1/true/yes', () => {
  for (const raw of ['1', 'true', 'yes', ' TRUE ', '\tYeS\n', ' 1 ']) {
    assert.equal(envFlagOn(raw), true)
    assert.equal(disabledByEnv({ DSH_SESSION_BRIDGE_DISABLE: raw }), true)
    assert.equal(hapiPeerToolsDisabledByEnv({ HAPI_DISABLE_PEER_TOOLS: raw }), true)
  }
  for (const raw of [undefined, null, true, false, 1, 0, '', ' ', '0', 'false', 'no', 'on', 'y', 'true-ish', ['yes']]) {
    assert.equal(envFlagOn(raw), false)
    assert.equal(disabledByEnv({ DSH_SESSION_BRIDGE_DISABLE: raw }), false)
    assert.equal(hapiPeerToolsDisabledByEnv({ HAPI_DISABLE_PEER_TOOLS: raw }), false)
  }
  assert.equal(disabledByEnv({ HAPI_DISABLE_PEER_TOOLS: 'yes' }), false)
  assert.equal(hapiPeerToolsDisabledByEnv({ DSH_SESSION_BRIDGE_DISABLE: 'yes' }), false)
})

test('environment helpers default to process.env', () => {
  const keys = ['DSH_SESSION_BRIDGE_DISABLE', 'HAPI_DISABLE_PEER_TOOLS']
  const previous = keys.map((key) => process.env[key])
  try {
    process.env.DSH_SESSION_BRIDGE_DISABLE = ' YES '
    process.env.HAPI_DISABLE_PEER_TOOLS = ' TrUe '
    assert.equal(disabledByEnv(), true)
    assert.equal(hapiPeerToolsDisabledByEnv(), true)
    assert.equal(compatibilityOf({ hapiCompat: 'hub' }), null)
  } finally {
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
  }
})

test('auto compatibility stays local without a hub block or complete environment pair', () => {
  for (const config of [undefined, null, {}, { hapiCompat: 'auto' }]) {
    assert.deepEqual(compatibilityOf(config, {}), { mode: 'local' })
  }
  for (const env of [
    { CLI_API_TOKEN: 'secret-token' },
    { HAPI_API_URL: 'http://hub.test' },
    { HAPI_API_URL: ' \t', CLI_API_TOKEN: 'secret-token' },
    { HAPI_API_URL: 'http://hub.test', CLI_API_TOKEN: '\n ' },
    { HAPI_API_URL: true, CLI_API_TOKEN: 'secret-token' },
    { HAPI_API_URL: 'http://hub.test', CLI_API_TOKEN: 1 },
  ]) {
    assert.deepEqual(compatibilityOf({}, env), { mode: 'local' })
  }
})

test('auto compatibility chooses hub for a block or complete environment pair', () => {
  for (const hub of [{}, { apiUrl: 'http://hub.test', accessToken: 'secret-token' }]) {
    const result = compatibilityOf({ hapiHub: hub }, {})
    assert.deepEqual(result, { mode: 'hub', hub, explicit: false })
    assert.equal(result.hub, hub)
  }
  assert.deepEqual(compatibilityOf({ hapiCompat: 'auto' }, {
    HAPI_API_URL: ' http://hub.test ',
    CLI_API_TOKEN: ' secret-token ',
  }), { mode: 'hub', hub: {}, explicit: false })
})

test('only an object block counts as configured hapiHub', () => {
  for (const hapiHub of [null, false, '', 'http://hub.test', []]) {
    assert.deepEqual(compatibilityOf({ hapiHub }, {}), { mode: 'local' })
    assert.deepEqual(compatibilityOf({ hapiCompat: 'hub', hapiHub }, {}), { mode: 'hub', hub: {}, explicit: true })
  }
})

test('explicit compatibility modes override auto detection', () => {
  const env = { HAPI_API_URL: 'http://hub.test', CLI_API_TOKEN: 'secret-token' }
  for (const hapiCompat of [false, 'none']) {
    assert.equal(compatibilityOf({ hapiCompat }, {}), null)
    assert.equal(compatibilityOf({ hapiCompat, hapiHub: {} }, env), null)
  }
  assert.deepEqual(compatibilityOf({ hapiCompat: 'local', hapiHub: {} }, env), { mode: 'local' })
  assert.deepEqual(compatibilityOf({ hapiCompat: 'hub' }, {}), { mode: 'hub', hub: {}, explicit: true })
  const hub = { apiUrl: 'http://configured-hub.test' }
  assert.deepEqual(compatibilityOf({ hapiCompat: 'hub', hapiHub: hub }, env), { mode: 'hub', hub, explicit: true })
})

test('HAPI peer kill switch overrides every compatibility mode', () => {
  for (const hapiCompat of [undefined, 'auto', 'local', 'hub']) {
    assert.equal(compatibilityOf({ hapiCompat, hapiHub: {} }, {
      HAPI_DISABLE_PEER_TOOLS: ' YES ',
      HAPI_API_URL: 'http://hub.test',
      CLI_API_TOKEN: 'secret-token',
    }), null)
  }
  assert.deepEqual(compatibilityOf({}, { HAPI_DISABLE_PEER_TOOLS: 'false' }), { mode: 'local' })
})

test('messageBudgetOf accepts positive safe integers and otherwise uses 64 KiB', () => {
  assert.equal(DEFAULT_MAX_MESSAGE_BYTES, 64 * 1024)
  assert.equal(messageBudgetOf(), DEFAULT_MAX_MESSAGE_BYTES)
  assert.equal(messageBudgetOf(null), DEFAULT_MAX_MESSAGE_BYTES)
  assert.equal(messageBudgetOf({}), DEFAULT_MAX_MESSAGE_BYTES)
  for (const maxMessageBytes of [1, 1024, Number.MAX_SAFE_INTEGER]) {
    assert.equal(messageBudgetOf({ maxMessageBytes }), maxMessageBytes)
  }
  for (const maxMessageBytes of [undefined, null, 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1024', true]) {
    assert.equal(messageBudgetOf({ maxMessageBytes }), DEFAULT_MAX_MESSAGE_BYTES)
  }
})
