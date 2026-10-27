import test from 'node:test'
import assert from 'node:assert/strict'

import { HapiHubError, createHapiHubClient } from '../hapi-hub.js'

const realFetch = globalThis.fetch

/**
 * Minimal in-memory hub that speaks the HAPI wire used by hapi-hub.js.
 * Every reply mirrors the shapes of `@twsxtd/hapi` 0.30.x (see HAPI docs).
 */
function makeHub({ sessions, token = 'jwt-1' }) {
  const state = {
    token,
    sessions: sessions.map((session) => ({ active: false, updatedAt: 1, metadata: {}, ...session })),
    calls: [],
    authCalls: 0,
    resumes: 0,
    sends: [],
    failNextSend: undefined,
    messages: new Map(),
  }
  const reply = async (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data })
  const summaryOf = (session) => ({
    id: session.id,
    active: session.active === true,
    updatedAt: session.updatedAt,
    metadata: session.metadata,
  })

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    state.calls.push({ pathname: url.pathname, method, headers: init.headers ?? {}, body, search: url.searchParams })

    if (url.pathname === '/api/auth' && method === 'POST') {
      state.authCalls += 1
      return body?.accessToken === 'secret-token'
        ? reply(200, { token: state.token })
        : reply(401, { error: 'invalid access token' })
    }
    if (init.headers?.Authorization !== `Bearer ${state.token}`) {
      return reply(401, { error: 'Missing authorization token' })
    }

    if (url.pathname === '/api/sessions' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 0)
      const rows = [...state.sessions].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      return reply(200, { sessions: (limit > 0 ? rows.slice(0, limit) : rows).map(summaryOf) })
    }

    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|resume))?$/)
    if (match === null) return reply(404, { error: 'not found' })
    const sessionId = decodeURIComponent(match[1])
    const action = match[2]
    const session = state.sessions.find((item) => item.id === sessionId)

    if (action === undefined) {
      return session === undefined ? reply(404, { error: 'Session not found' }) : reply(200, { session: summaryOf(session) })
    }
    if (action === 'resume' && method === 'POST') {
      if (session === undefined) return reply(404, { error: 'Session not found' })
      state.resumes += 1
      session.active = true
      return reply(200, { type: 'success', sessionId })
    }
    if (action === 'messages') {
      if (session === undefined) return reply(404, { error: 'Session not found' })
      if (method === 'GET') {
        const rows = (state.messages.get(sessionId) ?? []).map((content, index) => ({ id: `${sessionId}-${index}`, seq: index + 1, content }))
        return reply(200, { messages: rows, page: {} })
      }
      if (method === 'POST') {
        const failure = state.failNextSend
        if (failure !== undefined) {
          state.failNextSend = undefined
          return reply(409, { error: failure, code: failure })
        }
        if (session.active !== true) return reply(409, { error: 'session is not active', code: 'session_inactive' })
        state.sends.push({ sessionId, body })
        return reply(200, { ok: true })
      }
    }
    return reply(404, { error: 'not found' })
  }
  return { state, summaryOf }
}

function client(overrides = {}) {
  return createHapiHubClient({ apiUrl: 'http://127.0.0.1:3006', accessToken: 'secret-token', ...overrides })
}

test.after(() => {
  globalThis.fetch = realFetch
})

test('clients require an access token', () => {
  const previous = process.env.CLI_API_TOKEN
  delete process.env.CLI_API_TOKEN
  try {
    assert.throws(() => createHapiHubClient({ apiUrl: 'http://127.0.0.1:3006' }), (error) => error instanceof HapiHubError && error.code === 'bad_args')
  } finally {
    if (previous === undefined) delete process.env.CLI_API_TOKEN
    else process.env.CLI_API_TOKEN = previous
  }
})

test('listPeers authenticates once, sorts newest first, and excludes the calling session', async () => {
  makeHub({
    sessions: [
      { id: 's-self', updatedAt: 10, metadata: { flavor: 'dsh' } },
      { id: 's-a', updatedAt: 50, metadata: { flavor: 'dsh', name: 'Alpha', path: '/work/alpha' } },
      { id: 's-b', updatedAt: 90, metadata: { flavor: 'pi', summary: { text: 'Beta task' } } },
      { id: 's-c', updatedAt: 20, metadata: {} },
      { id: 's-d', updatedAt: 70, metadata: { name: '  spaced   name  ' } },
      { id: 's-e', updatedAt: 30 },
      { id: 's-f', updatedAt: 40 },
    ],
  })
  const hub = client({ selfSessionId: 's-self' })
  const peers = await hub.listPeers({ limit: 2 })
  assert.equal(hub.apiUrl, 'http://127.0.0.1:3006')
  assert.deepEqual(peers.map((peer) => peer.id), ['s-b', 's-d'])
  assert.equal(peers[0].name, 'Beta task')
  assert.equal(peers[1].name, 'spaced name')
  assert.equal(peers[0].flavor, 'pi')
  // self is excluded even when it is the newest row.
  assert.equal((await hub.listPeers({ limit: 100 })).some((peer) => peer.id === 's-self'), false)
})

test('inspectPeer resolves a unique id prefix and maps readable messages', async () => {
  const hubState = makeHub({
    sessions: [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', active: true, updatedAt: 5, metadata: { flavor: 'dsh', path: '/work/proj' } }],
  })
  const sessionId = 'aaaaaaaa-1111-2222-3333-444444444444'
  hubState.state.messages.set(sessionId, [
    { role: 'user', content: { type: 'text', text: 'hello from A' } },
    { role: 'assistant', content: [{ type: 'text', text: 'reply from B' }] },
    { role: 'system', content: { type: 'text', text: 'internal' } },
    { role: 'user', content: { type: 'text', text: '   ' } },
  ])
  const inspected = await client().inspectPeer({ sessionIdPrefix: 'aaaaaaaa', messageLimit: 10 })
  assert.equal(inspected.sessionId, sessionId)
  assert.equal(inspected.active, true)
  assert.equal(inspected.flavor, 'dsh')
  assert.equal(inspected.cwd, '/work/proj')
  assert.deepEqual(inspected.messages.map((message) => message.role), ['user', 'assistant'])
  assert.equal(inspected.messages[1].text, 'reply from B')
})

test('inspectPeer reports ambiguous prefixes and missing sessions', async () => {
  makeHub({
    sessions: [
      { id: 'prefix-one-1111', updatedAt: 2 },
      { id: 'prefix-two-2222', updatedAt: 1 },
    ],
  })
  await assert.rejects(client().inspectPeer({ sessionIdPrefix: 'prefix-' }), (error) => error instanceof HapiHubError && error.code === 'ambiguous')
  await assert.rejects(client().inspectPeer({ sessionIdPrefix: 'nope' }), (error) => error instanceof HapiHubError && error.code === 'not_found')
})

test('pingPeer resumes an inactive session, waits for active, then sends', async () => {
  const hub = makeHub({ sessions: [{ id: 'resume-me-1111', active: false, updatedAt: 1 }] })
  const result = await client().pingPeer({ sessionIdPrefix: 'resume-me', message: 'PING' })
  assert.equal(result.sessionId, 'resume-me-1111')
  assert.equal(result.resumed, true)
  assert.equal(hub.state.resumes, 1)
  assert.equal(hub.state.sends.length, 1)
  assert.equal(hub.state.sends[0].body.text, 'PING')
  assert.match(hub.state.sends[0].body.localId, /^[0-9a-f-]{36}$/)
})

test('pingPeer sends directly to an active session without resuming', async () => {
  const hub = makeHub({ sessions: [{ id: 'active-1111', active: true, updatedAt: 1 }] })
  const result = await client().pingPeer({ sessionIdPrefix: 'active-', message: 'hello' })
  assert.equal(result.resumed, false)
  assert.equal(hub.state.resumes, 0)
  assert.equal(hub.state.sends.length, 1)
})

test('pingPeer retries once after a 409 session_inactive', async () => {
  const hub = makeHub({ sessions: [{ id: 'flap-1111', active: true, updatedAt: 1 }] })
  hub.state.failNextSend = 'session_inactive'
  const result = await client().pingPeer({ sessionIdPrefix: 'flap-', message: 'retry me' })
  assert.equal(result.resumed, false)
  // The retry goes through ensureActive(), which re-reads the session first.
  assert.equal(hub.state.sends.length, 1)
})

test('pingPeer rejects empty messages and self-targeting', async () => {
  makeHub({ sessions: [{ id: 'self-1111', active: true, updatedAt: 1 }] })
  await assert.rejects(client({ selfSessionId: 'self-1111' }).pingPeer({ sessionIdPrefix: 'self-', message: 'x' }), (error) => error instanceof HapiHubError && error.code === 'bad_args')
  await assert.rejects(client().pingPeer({ sessionIdPrefix: 'self-', message: '   ' }), (error) => error instanceof HapiHubError && error.code === 'bad_args')
})

test('a 401 from the hub triggers exactly one re-authentication', async () => {
  const hub = makeHub({ sessions: [{ id: 'a-1111', active: true, updatedAt: 1 }] })
  const hubClient = client()
  await hubClient.listPeers({ limit: 5 })
  assert.equal(hub.state.authCalls, 1)
  hub.state.token = 'jwt-2' // invalidate the cached JWT
  const peers = await hubClient.listPeers({ limit: 5 })
  assert.equal(peers.length, 1)
  assert.equal(hub.state.authCalls, 2)
})
