import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeCitationId, extractCitationIds, isFullSessionId, matchSessionRef, normalizeSessionRef } from '../refs.js'

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

test('matchSessionRef enforces the minimum on the variable prefix part', () => {
  const ids = ['session-aaaa1111-bbbb', 'session-bbbb2222-cccc', 'session-bbbb2222-dddd']
  const options = { minPrefixChars: 8 }
  for (const ref of ['s', 'session-', 'session-a', 'session-aaaa111', 'aaaa111']) {
    assert.deepEqual(matchSessionRef(ids, ref, options), { tooShort: true })
  }
  assert.deepEqual(matchSessionRef(ids, ' session-aaaa1111 ', options), { id: ids[0] })
  assert.deepEqual(matchSessionRef(ids, 'session-bbbb2222', options), { ambiguous: ids.slice(1) })
  assert.deepEqual(matchSessionRef(ids, 'session-cccc3333', options), { missing: true })
  assert.deepEqual(matchSessionRef(['aaaa1111-bbbb'], 'aaaa111', options), { tooShort: true })
  assert.deepEqual(matchSessionRef(['aaaa1111-bbbb'], 'aaaa1111', options), { id: 'aaaa1111-bbbb' })
  assert.deepEqual(matchSessionRef(['session-aaaa1111-bbbb'], 'session-a', { minPrefixChars: 1 }), { id: ids[0] })
})

test('matchSessionRef exact ids win even below the prefix minimum', () => {
  const ids = ['s', 'session-ab', 'session-abcd']
  assert.deepEqual(matchSessionRef(ids, 's', { minPrefixChars: 8 }), { id: 's' })
  assert.deepEqual(matchSessionRef(ids, ' session-ab ', { minPrefixChars: 8 }), { id: 'session-ab' })
  assert.deepEqual(matchSessionRef(['session-abcd'], 'session-ab'), { id: 'session-abcd' })
})

test('isFullSessionId accepts only canonical UUIDs with an optional session prefix', () => {
  const uuid = '3f2a1b9c-1234-5678-90ab-cdef12345678'
  for (const value of [uuid, `session-${uuid}`, uuid.toUpperCase(), `session-${uuid.toUpperCase()}`]) {
    assert.equal(isFullSessionId(value), true)
  }
  for (const value of [
    undefined, null, 42, '', 's', 'session-', '3f2a1b9c', 'session-3f2a1b9c',
    '../../something', `/sessions/${uuid}`, ` ${uuid}`, `${uuid} `, `${uuid}\n`,
    uuid.replace(/-/g, ''), uuid.slice(0, -1), `${uuid}0`, uuid.replace('3', 'g'),
    `session-session-${uuid}`,
  ]) {
    assert.equal(isFullSessionId(value), false)
  }
})
