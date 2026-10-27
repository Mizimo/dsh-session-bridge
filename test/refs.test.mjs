import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeCitationId, extractCitationIds, matchSessionRef, normalizeSessionRef } from '../refs.js'

test('bare ids and prefixes are normalized by trimming only', () => {
  assert.equal(normalizeSessionRef('  session-abc  '), 'session-abc')
  assert.equal(normalizeSessionRef('session-abc'), 'session-abc')
  assert.equal(normalizeSessionRef(''), '')
  assert.equal(normalizeSessionRef(undefined), '')
  assert.equal(normalizeSessionRef(42), '')
})

test('a single /sessions/<id> citation is extracted', () => {
  const text = 'see [the session](https://hub.tailnet.ts.net/sessions/session-abc-123?tab=chat) for details'
  assert.equal(normalizeSessionRef(text), 'session-abc-123')
  assert.deepEqual(extractCitationIds(text), ['session-abc-123'])
})

test('several distinct citation ids fail closed', () => {
  const text = '/sessions/session-one and /sessions/session-two'
  assert.deepEqual(extractCitationIds(text), ['session-one', 'session-two'])
  assert.equal(normalizeSessionRef(text), '')
})

test('the same citation id repeated stays usable', () => {
  const text = '/sessions/session-one and again /sessions/session-one'
  assert.equal(normalizeSessionRef(text), 'session-one')
})

test('dotted lookalikes (file paths) are rejected', () => {
  assert.equal(decodeCitationId('chat.tsx'), '')
  assert.equal(normalizeSessionRef('open web/src/routes/sessions/chat.tsx'), '')
})

test('trailing punctuation and percent-encoding are handled', () => {
  assert.equal(decodeCitationId('session-abc.'), 'session-abc')
  assert.equal(normalizeSessionRef('/sessions/session-abc).'), 'session-abc')
  assert.equal(normalizeSessionRef('/sessions/session%2Dabc'), 'session-abc')
})

test('matchSessionRef resolves exact, unique prefix, ambiguous and missing', () => {
  const ids = ['session-aaaa1111', 'session-bbbb2222', 'session-bbbb3333']
  assert.deepEqual(matchSessionRef(ids, 'session-aaaa1111'), { id: 'session-aaaa1111' })
  assert.deepEqual(matchSessionRef(ids, 'session-aaaa'), { id: 'session-aaaa1111' })
  assert.deepEqual(matchSessionRef(ids, 'session-bbbb'), { ambiguous: ['session-bbbb2222', 'session-bbbb3333'] })
  assert.deepEqual(matchSessionRef(ids, 'session-cccc'), { missing: true })
  assert.deepEqual(matchSessionRef(ids, ''), { missing: true })
})
