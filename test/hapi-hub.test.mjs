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
    piGenerations: new Map(),
    probes: [],
    sendAttempts: [],
    sends: [],
    failNextSend: undefined,
    messages: new Map(),
  }
  const reply = async (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data })
  const summaryOf = (session) => ({
    id: session.id,
    active: session.active === true,
    updatedAt: session.updatedAt,
    metadata: { ...session.metadata },
  })

  globalThis.fetch = async (input, init = {}) => {
    init.signal?.throwIfAborted()
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
      if (session === undefined) return reply(404, { error: 'Session not found' })
      const pi = state.piGenerations.get(sessionId)
      if (pi !== undefined && session.active === true) {
        if (session.metadata.piSessionId !== undefined && session.dropAfterPiReady > 0) {
          // Drop on the probe after publishing this generation's Pi id.
          session.active = false
          session.dropAfterPiReady -= 1
        } else if (session.metadata.piSessionId === undefined) {
          pi.polls += 1
          if (pi.polls >= (session.piReadyPolls?.[pi.generation - 1] ?? 1)) {
            session.metadata.piSessionId = `pi-${sessionId}-${pi.generation}`
          }
        }
      }
      state.probes.push({ ...summaryOf(session), generation: pi?.generation, polls: pi?.polls })
      return reply(200, { session: summaryOf(session) })
    }
    if (action === 'resume' && method === 'POST') {
      if (session === undefined) return reply(404, { error: 'Session not found' })
      state.resumes += 1
      session.active = true
      if (session.metadata.flavor === 'pi') {
        const generation = (state.piGenerations.get(sessionId)?.generation ?? 0) + 1
        state.piGenerations.set(sessionId, { generation, polls: 0 })
        delete session.metadata.piSessionId
      }
      return reply(200, { type: 'success', sessionId })
    }
    if (action === 'messages') {
      if (session === undefined) return reply(404, { error: 'Session not found' })
      if (method === 'GET') {
        const rows = (state.messages.get(sessionId) ?? []).map((content, index) => ({ id: `${sessionId}-${index}`, seq: index + 1, content }))
        return reply(200, { messages: rows, page: {} })
      }
      if (method === 'POST') {
        const pi = state.piGenerations.get(sessionId)
        const attempt = { sessionId, body, piSessionId: session.metadata.piSessionId, generation: pi?.generation, polls: pi?.polls }
        state.sendAttempts.push(attempt)
        const failure = state.failNextSend
        if (failure !== undefined) {
          state.failNextSend = undefined
          if (failure.inactive === true) session.active = false
          const code = typeof failure === 'string' ? failure : failure.code
          return reply(409, { error: code, code })
        }
        if (session.active !== true) return reply(409, { error: 'session is not active', code: 'session_inactive' })
        state.sends.push(attempt)
        return reply(200, { ok: true })
      }
    }
    return reply(404, { error: 'not found' })
  }
  return { state, summaryOf }
}

function client(overrides = {}) {
  return createHapiHubClient({ apiUrl: 'http://127.0.0.1:3006', accessToken: 'secret-token', pollActiveMs: 1, pollPiReadyMs: 1, ...overrides })
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
  assert.equal(inspected.truncated, false)
})

test('inspectPeer reports truncation only for returned text longer than 1200 characters', async () => {
  const { state } = makeHub({ sessions: [{ id: 'long-1111', active: true }] })
  const hub = client()
  state.messages.set('long-1111', [
    { role: 'user', content: 'x'.repeat(1201) },
    { role: 'assistant', content: 'short reply' },
  ])
  const truncated = await hub.inspectPeer({ sessionIdPrefix: 'long-' })
  assert.equal(truncated.truncated, true)
  assert.deepEqual(truncated.messages, [
    { role: 'user', text: `${'x'.repeat(1199)}…` },
    { role: 'assistant', text: 'short reply' },
  ])

  state.messages.set('long-1111', [
    { role: 'system', content: 'x'.repeat(1201) },
    { role: 'assistant', content: 'x'.repeat(1200) },
  ])
  const exact = await hub.inspectPeer({ sessionIdPrefix: 'long-' })
  assert.equal(exact.truncated, false)
  assert.deepEqual(exact.messages, [{ role: 'assistant', text: 'x'.repeat(1200) }])
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

test('pingPeer waits for an initially inactive Pi session to publish piSessionId', async () => {
  const { state } = makeHub({
    sessions: [{ id: 'pi-cold-1111', metadata: { flavor: 'pi' }, piReadyPolls: [4] }],
  })
  const result = await client().pingPeer({ sessionIdPrefix: 'pi-cold-', message: 'wait for Pi' })
  assert.equal(result.resumed, true)
  assert.equal(state.resumes, 1)
  assert.equal(state.sendAttempts.length, 1)
  assert.equal(state.sends[0].piSessionId, 'pi-pi-cold-1111-1')
  assert.equal(state.sends[0].polls, 4)
  assert.equal(state.probes.filter((probe) => probe.generation === 1 && probe.metadata.piSessionId === undefined).length, 3)
})

test('pingPeer waits for the new Pi id after a second resume during readiness', async () => {
  const { state } = makeHub({
    sessions: [{ id: 'pi-flap-1111', metadata: { flavor: 'pi' }, piReadyPolls: [3, 4], dropAfterPiReady: 1 }],
  })
  const result = await client().pingPeer({ sessionIdPrefix: 'pi-flap-', message: 'wait again' })
  assert.equal(result.resumed, true)
  assert.equal(state.resumes, 2)
  assert.equal(state.sendAttempts.length, 1)
  assert.equal(state.sends[0].generation, 2)
  assert.equal(state.sends[0].piSessionId, 'pi-pi-flap-1111-2')
  assert.equal(state.sends[0].polls, 4)
  assert.equal(state.probes.filter((probe) => probe.generation === 2 && probe.metadata.piSessionId === undefined).length, 3)
})

test('pingPeer repeats the Pi readiness guard across several resumes', async () => {
  const { state } = makeHub({
    sessions: [{ id: 'pi-repeat-1111', metadata: { flavor: 'pi' }, piReadyPolls: [3, 4, 5, 3], dropAfterPiReady: 3 }],
  })
  const result = await client().pingPeer({ sessionIdPrefix: 'pi-repeat-', message: 'keep waiting' })
  assert.equal(result.resumed, true)
  assert.equal(state.resumes, 4)
  assert.equal(state.sendAttempts.length, 1)
  assert.equal(state.sends[0].generation, 4)
  assert.equal(state.sends[0].piSessionId, 'pi-pi-repeat-1111-4')
  assert.equal(state.sends[0].polls, 3)
})

test('pingPeer waits for Pi readiness after a 409 session_inactive resume', async () => {
  const { state } = makeHub({
    sessions: [{ id: 'pi-retry-1111', active: true, metadata: { flavor: 'pi', piSessionId: 'pi-original' }, piReadyPolls: [4] }],
  })
  state.failNextSend = { code: 'session_inactive', inactive: true }
  const result = await client().pingPeer({ sessionIdPrefix: 'pi-retry-', message: 'retry Pi' })
  assert.equal(result.resumed, true)
  assert.equal(state.resumes, 1)
  assert.equal(state.sendAttempts.length, 2)
  assert.equal(state.sendAttempts[0].piSessionId, 'pi-original')
  assert.equal(state.sends.length, 1)
  assert.equal(state.sends[0].piSessionId, 'pi-pi-retry-1111-1')
  assert.equal(state.sends[0].polls, 4)
  assert.equal(state.sendAttempts[0].body.localId, state.sendAttempts[1].body.localId)
})

test('pingPeer retries once after a 409 session_inactive', async () => {
  const hub = makeHub({ sessions: [{ id: 'flap-1111', active: true, updatedAt: 1 }] })
  hub.state.failNextSend = 'session_inactive'
  const result = await client().pingPeer({ sessionIdPrefix: 'flap-', message: 'retry me' })
  assert.equal(result.resumed, false)
  // The retry goes through ensureActive(), which re-reads the session first.
  assert.equal(hub.state.sends.length, 1)
  assert.equal(hub.state.sendAttempts.length, 2)
  assert.equal(hub.state.sendAttempts[0].body.localId, hub.state.sendAttempts[1].body.localId)
})

test('pingPeer stops after one retry on 409 session_inactive', async () => {
  const { state } = makeHub({ sessions: [{ id: 'retry-limit-1111', active: true }] })
  const hubFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    if (init.method === 'POST' && new URL(String(input)).pathname.endsWith('/messages')) {
      state.failNextSend = 'session_inactive'
    }
    return hubFetch(input, init)
  }
  await assert.rejects(client().pingPeer({ sessionIdPrefix: 'retry-limit-', message: 'retry once' }), (error) => error instanceof HapiHubError && error.code === 'send_failed')
  assert.equal(state.sendAttempts.length, 2)
  assert.equal(state.sends.length, 0)
  assert.equal(state.sendAttempts[0].body.localId, state.sendAttempts[1].body.localId)
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

test('listPeers can cancel its first authentication request', async () => {
  makeHub({ sessions: [] })
  const controller = new AbortController()
  const hubFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    if (new URL(String(input)).pathname === '/api/auth') {
      await Promise.resolve()
      controller.abort(new Error('caller cancelled auth'))
    }
    return hubFetch(input, init)
  }
  await assert.rejects(client().listPeers({ signal: controller.signal }), (error) => error instanceof HapiHubError && error.code === 'disabled')
})

test('peer operations forward cancellation into session listing', async (t) => {
  for (const operation of ['listPeers', 'inspectPeer', 'pingPeer']) {
    await t.test(operation, async () => {
      const { state } = makeHub({ sessions: [{ id: 'cancel-1111', active: true }] })
      const hub = client()
      await hub.listPeers() // Cache the JWT so cancellation exercises the list.
      const controller = new AbortController()
      const hubFetch = globalThis.fetch
      globalThis.fetch = async (input, init = {}) => {
        if (new URL(String(input)).pathname === '/api/sessions') {
          await Promise.resolve()
          controller.abort()
        }
        return hubFetch(input, init)
      }
      await assert.rejects(hub[operation]({ sessionIdPrefix: 'cancel-', message: 'cancel me', signal: controller.signal }), (error) => error instanceof HapiHubError && error.code === 'disabled')
      assert.equal(state.resumes, 0)
      assert.equal(state.sendAttempts.length, 0)
    })
  }
})

test('caller cancellation also interrupts re-authentication', async () => {
  const { state } = makeHub({ sessions: [] })
  const hub = client()
  await hub.listPeers()
  state.token = 'jwt-2'
  const controller = new AbortController()
  const hubFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    if (new URL(String(input)).pathname === '/api/auth') controller.abort()
    return hubFetch(input, init)
  }
  await assert.rejects(hub.listPeers({ signal: controller.signal }), (error) => error instanceof HapiHubError && error.code === 'disabled')
})

test('connection failures include the failing URL and underlying error', async (t) => {
  for (const pathname of ['/api/auth', '/api/sessions']) {
    await t.test(pathname, async () => {
      makeHub({ sessions: [] })
      const hubFetch = globalThis.fetch
      globalThis.fetch = async (input, init = {}) => {
        if (new URL(String(input)).pathname === pathname) {
          throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:3006') })
        }
        return hubFetch(input, init)
      }
      await assert.rejects(client().listPeers(), (error) => {
        assert.ok(error instanceof HapiHubError)
        assert.equal(error.code, 'unavailable')
        assert.match(error.message, /connection failed/)
        assert.match(error.message, /ECONNREFUSED/)
        assert.ok(error.message.includes(`http://127.0.0.1:3006${pathname}`))
        return true
      })
    })
  }
})

test('HTTP 5xx responses are unavailable across all hub endpoints', async (t) => {
  const endpoints = [
    { pathname: '/api/auth', method: 'POST', operation: 'listPeers' },
    { pathname: '/api/sessions', method: 'GET', operation: 'listPeers' },
    { pathname: '/api/sessions/error-1111', method: 'GET', operation: 'inspectPeer' },
    { pathname: '/api/sessions/error-1111/messages', method: 'GET', operation: 'inspectPeer' },
    { pathname: '/api/sessions/error-1111/resume', method: 'POST', operation: 'pingPeer' },
    { pathname: '/api/sessions/error-1111/messages', method: 'POST', operation: 'pingPeer' },
  ]
  for (const endpoint of endpoints) {
    await t.test(`${endpoint.method} ${endpoint.pathname}`, async () => {
      makeHub({ sessions: [{ id: 'error-1111', active: !endpoint.pathname.endsWith('/resume') }] })
      const hubFetch = globalThis.fetch
      globalThis.fetch = async (input, init = {}) => {
        if (new URL(String(input)).pathname === endpoint.pathname && (init.method ?? 'GET') === endpoint.method) {
          return { status: 503, ok: false, json: async () => ({ error: 'temporarily unavailable' }) }
        }
        return hubFetch(input, init)
      }
      await assert.rejects(client()[endpoint.operation]({ sessionIdPrefix: 'error-', message: 'test failure' }), (error) => {
        assert.ok(error instanceof HapiHubError)
        assert.equal(error.code, 'unavailable')
        assert.match(error.message, /HTTP 503/)
        assert.ok(error.message.includes(`http://127.0.0.1:3006${endpoint.pathname}`))
        return true
      })
    })
  }
})

test('HTTP authentication, missing-resource and domain failures keep their codes', async (t) => {
  const failures = [
    { pathname: '/api/auth', status: 401, code: 'auth_failed', operation: 'listPeers' },
    { pathname: '/api/auth', status: 403, code: 'auth_failed', operation: 'listPeers' },
    { pathname: '/api/auth', status: 400, code: 'auth_failed', operation: 'listPeers' },
    { pathname: '/api/auth', status: 200, code: 'auth_failed', operation: 'listPeers' },
    { pathname: '/api/sessions', status: 401, code: 'auth_failed', operation: 'listPeers' },
    { pathname: '/api/sessions', status: 403, code: 'auth_failed', operation: 'listPeers' },
    { pathname: '/api/sessions', status: 404, code: 'not_found', operation: 'listPeers' },
    { pathname: '/api/sessions/error-1111', status: 403, code: 'auth_failed', operation: 'inspectPeer' },
    { pathname: '/api/sessions/error-1111/messages', status: 403, code: 'auth_failed', operation: 'inspectPeer' },
    { pathname: '/api/sessions/error-1111/resume', status: 403, code: 'auth_failed', operation: 'pingPeer' },
    { pathname: '/api/sessions/error-1111/resume', status: 404, code: 'not_found', operation: 'pingPeer' },
    { pathname: '/api/sessions/error-1111/resume', status: 409, code: 'resume_failed', operation: 'pingPeer' },
    { pathname: '/api/sessions/error-1111/messages', status: 403, code: 'auth_failed', operation: 'pingPeer' },
    { pathname: '/api/sessions/error-1111/messages', status: 404, code: 'not_found', operation: 'pingPeer' },
    { pathname: '/api/sessions/error-1111/messages', status: 400, code: 'send_failed', operation: 'pingPeer' },
  ]
  for (const failure of failures) {
    await t.test(`${failure.operation} ${failure.pathname} HTTP ${failure.status}`, async () => {
      const { state } = makeHub({ sessions: [{ id: 'error-1111', active: !failure.pathname.endsWith('/resume') }] })
      const hubFetch = globalThis.fetch
      globalThis.fetch = async (input, init = {}) => {
        if (new URL(String(input)).pathname === failure.pathname) {
          return { status: failure.status, ok: failure.status === 200, json: async () => ({ error: 'rejected' }) }
        }
        return hubFetch(input, init)
      }
      await assert.rejects(client()[failure.operation]({ sessionIdPrefix: 'error-', message: 'test failure' }), (error) => error instanceof HapiHubError && error.code === failure.code)
      if (failure.pathname === '/api/sessions' && failure.status === 401) assert.equal(state.authCalls, 2)
    })
  }
})

test('authentication and hub request timeouts keep the timeout code', async (t) => {
  for (const pathname of ['/api/auth', '/api/sessions']) {
    await t.test(pathname, async () => {
      makeHub({ sessions: [] })
      const hubFetch = globalThis.fetch
      globalThis.fetch = async (input, init = {}) => {
        if (new URL(String(input)).pathname === pathname) throw new DOMException('request timed out', 'TimeoutError')
        return hubFetch(input, init)
      }
      await assert.rejects(client().listPeers(), (error) => error instanceof HapiHubError && error.code === 'timeout')
    })
  }
})
