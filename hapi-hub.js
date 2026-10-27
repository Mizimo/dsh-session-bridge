/**
 * HAPI hub REST client for the Session Bridge.
 *
 * Mirrors the wire protocol of HAPI's own peer tools (tiann/hapi 0.31.x) so a
 * DSH session can list, inspect and message HAPI sessions on the same
 * hub/namespace:
 *
 * - `POST /api/auth` with `{ accessToken }` exchanges the CLI token for a JWT.
 * - `GET  /api/sessions?order=updatedAt` lists session summaries.
 * - `GET  /api/sessions/:id` reads one session summary.
 * - `GET  /api/sessions/:id/messages?limit=N` reads a message page.
 * - `POST /api/sessions/:id/resume` asks a runner to resume an inactive session.
 * - `POST /api/sessions/:id/messages` with `{ text }` delivers a user message.
 *
 * `pingPeer` reproduces HAPI's delivery policy: resolve by unique id prefix,
 * resume an inactive target, wait (2s poll, 60s budget) until it is active,
 * then post the message. `inspectPeer` is the read-only twin: it never resumes.
 *
 * Credentials come from row config (`apiUrl`, `accessToken`, `extraHeaders`,
 * `selfSessionId`) or the HAPI environment (`HAPI_API_URL`, `CLI_API_TOKEN`,
 * `HAPI_EXTRA_HEADERS_JSON`, `HAPI_SESSION_ID`). HAPI has no namespace header:
 * the namespace rides on the access token suffix / JWT `ns` claim, while
 * `extraHeaders` is only for deployment-specific headers.
 */
import { randomUUID } from 'node:crypto'

import { matchSessionRef, normalizeSessionRef } from './refs.js'

const DEFAULT_API_URL = 'http://127.0.0.1:3006'
const DEFAULT_TIMEOUT_MS = 20_000
const RESUME_TIMEOUT_MS = 30_000
const SEND_TIMEOUT_MS = 30_000
const AUTH_TIMEOUT_MS = 10_000
const DEFAULT_WAIT_ACTIVE_SECS = 60
const POLL_ACTIVE_MS = 2_000
const POLL_PI_READY_MS = 1_000
const MAX_LIST_LIMIT = 100
const MAX_MESSAGE_LIMIT = 100
const DEFAULT_MESSAGE_LIMIT = 30
const MAX_SNIPPET_CHARS = 1_200
const MAX_LABEL_CHARS = 255

/** Typed hub failure, mirroring HAPI's `PingPeerErrorCode`. */
export class HapiHubError extends Error {
  /** @param {'bad_args'|'disabled'|'auth_failed'|'not_found'|'ambiguous'|'resume_failed'|'timeout'|'send_failed'} code */
  constructor(code, message) {
    super(message)
    this.name = 'HapiHubError'
    this.code = code
  }
}

/** Trim and strip trailing slashes from a hub URL. */
function hubUrlOf(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

/** Parse the `HAPI_EXTRA_HEADERS_JSON` env format into a header object. */
function parseExtraHeaders(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Best-effort label for a hub session, mirroring HAPI's own shortlist label. */
function sessionLabel(summary) {
  const metadata = summary?.metadata ?? {}
  const pathLabel = typeof metadata.path === 'string'
    ? metadata.path.split(/[\\/]/).filter(Boolean).at(-1)?.trim()
    : undefined
  const raw = (typeof metadata.name === 'string' && metadata.name.trim())
    || (typeof metadata.summary?.text === 'string' && metadata.summary.text.trim())
    || pathLabel
    || String(summary?.id ?? '').slice(0, 8)
  const collapsed = String(raw).replace(/\s+/g, ' ').trim()
  if (collapsed === '') return String(summary?.id ?? '').slice(0, 8)
  return collapsed.length > MAX_LABEL_CHARS ? collapsed.slice(0, MAX_LABEL_CHARS) : collapsed
}

/** Extract readable text from one hub message content envelope. */
function messageSnippet(content) {
  if (content === null || typeof content !== 'object') return null
  const role = typeof content.role === 'string' ? content.role : 'unknown'
  const inner = content.content
  /** Join text blocks of one content array. */
  const blocksText = (blocks) => blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  let text = null
  if (typeof inner === 'string') text = inner
  else if (Array.isArray(inner)) text = blocksText(inner)
  else if (inner !== null && typeof inner === 'object') {
    if (typeof inner.text === 'string') text = inner.text
    else if (typeof inner.content === 'string') text = inner.content
    else if (Array.isArray(inner.content)) text = blocksText(inner.content)
    else if (inner.content !== null && typeof inner.content === 'object' && typeof inner.content.text === 'string') {
      text = inner.content.text
    }
  }
  if (typeof text !== 'string') return null
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return null
  // Only real conversation roles; a system/tool row would be misattributed.
  if (role !== 'user' && role !== 'assistant') return null
  return {
    role,
    text: collapsed.length > MAX_SNIPPET_CHARS ? `${collapsed.slice(0, MAX_SNIPPET_CHARS - 1)}…` : collapsed,
  }
}

/** Clamp a list limit the way HAPI does. */
function clampListLimit(raw, fallback = DEFAULT_MESSAGE_LIMIT) {
  if (!Number.isSafeInteger(raw) || raw < 1) return Math.min(MAX_LIST_LIMIT, fallback)
  return Math.min(MAX_LIST_LIMIT, raw)
}

/** Clamp an inspect message limit the way HAPI does. */
function clampMessageLimit(raw) {
  if (!Number.isSafeInteger(raw) || raw < 1) return DEFAULT_MESSAGE_LIMIT
  return Math.min(MAX_MESSAGE_LIMIT, raw)
}

/** Sleep helper that observes an abort signal. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new HapiHubError('disabled', 'hub request cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new HapiHubError('disabled', 'hub request cancelled'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Build one hub client. Throws `bad_args` when no hub URL or access token can
 * be resolved, so the plugin can fall back to local HAPI-compatible aliases.
 */
export function createHapiHubClient(config = {}) {
  const apiUrl = hubUrlOf(config.apiUrl ?? process.env.HAPI_API_URL) || DEFAULT_API_URL
  const accessToken = String(config.accessToken ?? process.env.CLI_API_TOKEN ?? '').trim()
  if (accessToken === '') {
    throw new HapiHubError('bad_args', 'HAPI hub accessToken is required (set hapiHub.accessToken or CLI_API_TOKEN)')
  }
  const extraHeaders = config.extraHeaders ?? parseExtraHeaders(process.env.HAPI_EXTRA_HEADERS_JSON)
  const selfSessionId = (typeof config.selfSessionId === 'string' && config.selfSessionId.trim() !== '')
    ? config.selfSessionId.trim()
    : (typeof process.env.HAPI_SESSION_ID === 'string' && process.env.HAPI_SESSION_ID.trim() !== '' ? process.env.HAPI_SESSION_ID.trim() : undefined)
  const timeoutMs = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const waitActiveSecs = Number.isFinite(config.waitActiveSecs) && config.waitActiveSecs > 0
    ? config.waitActiveSecs
    : DEFAULT_WAIT_ACTIVE_SECS

  let jwt
  let authInFlight

  /** Compose one request signal with a per-call timeout. */
  function requestSignal(signal, ms = timeoutMs) {
    const timeout = AbortSignal.timeout(ms)
    if (signal === undefined || typeof AbortSignal.any !== 'function') return timeout
    return AbortSignal.any([signal, timeout])
  }

  /** Exchange the access token for a hub JWT (single flight). */
  async function authenticate(force = false) {
    if (!force && typeof jwt === 'string') return jwt
    if (authInFlight !== undefined) return authInFlight
    authInFlight = (async () => {
      let response
      try {
        response = await fetch(`${apiUrl}/api/auth`, {
          method: 'POST',
          headers: { ...extraHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken }),
          signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
        })
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new HapiHubError('timeout', `hub auth timed out after ${AUTH_TIMEOUT_MS}ms. Hub URL: ${apiUrl}.`)
        }
        throw new HapiHubError('auth_failed', `hub auth request failed (${error instanceof Error ? error.message : String(error)}). Hub URL: ${apiUrl}.`)
      }
      const data = await response.json().catch(() => null)
      const token = typeof data?.token === 'string' ? data.token : ''
      if (!response.ok || token === '') {
        const detail = typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`
        throw new HapiHubError('auth_failed', `failed to exchange access token for JWT (${detail}). Hub URL: ${apiUrl}.`)
      }
      jwt = token
      return token
    })()
    try {
      return await authInFlight
    } finally {
      authInFlight = undefined
    }
  }

  /** One authenticated hub request with a single re-auth retry. */
  async function request(path, { method = 'GET', body, params, signal, timeoutMs: callTimeoutMs } = {}) {
    let token = await authenticate()
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = new URL(`${apiUrl}${path}`)
      if (params !== undefined) {
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) url.searchParams.set(key, String(value))
        }
      }
      let response
      try {
        response = await fetch(url, {
          method,
          headers: {
            ...extraHeaders,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: requestSignal(signal, callTimeoutMs),
        })
      } catch (error) {
        if (signal?.aborted === true) throw new HapiHubError('disabled', 'hub request cancelled')
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new HapiHubError('timeout', `hub request timed out. Hub URL: ${apiUrl}.`)
        }
        throw new HapiHubError('auth_failed', `hub request failed (${error instanceof Error ? error.message : String(error)}). Hub URL: ${apiUrl}.`)
      }
      if (response.status === 401 && attempt === 0) {
        token = await authenticate(true)
        continue
      }
      const data = await response.json().catch(() => null)
      return { status: response.status, ok: response.ok, data }
    }
    throw new HapiHubError('auth_failed', `hub authentication failed. Hub URL: ${apiUrl}.`)
  }

  /** Raw session summaries from the hub. */
  async function listSessionSummaries({ limit, order = 'updatedAt', signal } = {}) {
    const result = await request('/api/sessions', {
      params: { ...(limit === undefined ? {} : { limit }), order },
      signal,
    })
    if (!result.ok) {
      const detail = typeof result.data?.error === 'string' ? result.data.error : `HTTP ${result.status}`
      throw new HapiHubError('auth_failed', `failed to list HAPI sessions (${detail}). Hub URL: ${apiUrl}.`)
    }
    const rows = Array.isArray(result.data?.sessions) ? result.data.sessions : Array.isArray(result.data) ? result.data : null
    if (rows === null) throw new HapiHubError('auth_failed', 'failed to list HAPI sessions (unexpected response)')
    return rows
  }

  /** Read one session summary. */
  async function getSessionSummary(sessionId, signal) {
    const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}`, { signal })
    if (!result.ok || result.data?.session === undefined || result.data?.session === null) {
      const detail = typeof result.data?.error === 'string' ? result.data.error : `HTTP ${result.status}`
      throw new HapiHubError('not_found', `failed to load HAPI session ${sessionId} (${detail})`)
    }
    return result.data.session
  }

  /** Resolve a reference (bare id/prefix/citation) to one hub session. */
  async function resolveSession(rawRef) {
    const normalized = normalizeSessionRef(rawRef)
    if (normalized === '') throw new HapiHubError('bad_args', 'session reference is empty or contains several /sessions/<id> citations')
    const summaries = await listSessionSummaries({ order: 'updatedAt' })
    const ids = summaries.map((summary) => String(summary?.id ?? '')).filter((id) => id !== '')
    const match = matchSessionRef(ids, normalized)
    if (match.id !== undefined) {
      const summary = summaries.find((item) => item?.id === match.id) ?? { id: match.id }
      return { summary }
    }
    if (match.ambiguous !== undefined) {
      const sample = match.ambiguous.slice(0, 5).map((id) => id.slice(0, 8)).join(', ')
      throw new HapiHubError(
        'ambiguous',
        `session prefix "${normalized}" matches ${match.ambiguous.length} HAPI sessions (${sample}${match.ambiguous.length > 5 ? ', ...' : ''}); use a longer prefix or list_peers`,
      )
    }
    throw new HapiHubError('not_found', `no HAPI session matching "${normalized}" on this hub/namespace`)
  }

  /** Read one page of hub messages for a session. */
  async function fetchMessages(sessionId, limit, signal) {
    const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      params: { limit: clampMessageLimit(limit) },
      signal,
    })
    if (!result.ok) {
      const detail = typeof result.data?.error === 'string' ? result.data.error : `HTTP ${result.status}`
      throw new HapiHubError('not_found', `failed to load messages for ${sessionId} (${detail})`)
    }
    const rows = Array.isArray(result.data?.messages) ? result.data.messages : []
    const messages = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const snippet = messageSnippet(row.content)
      if (snippet === null) continue
      messages.push({ role: snippet.role === 'user' ? 'user' : snippet.role === 'assistant' ? 'assistant' : 'user', text: snippet.text })
    }
    return messages
  }

  /** Wait until the hub reports the session active. */
  async function waitUntilActive(sessionId, signal) {
    const deadline = Date.now() + waitActiveSecs * 1_000
    while (Date.now() < deadline) {
      const summary = await getSessionSummary(sessionId, signal)
      if (summary?.active === true) return summary
      await sleep(POLL_ACTIVE_MS, signal)
    }
    throw new HapiHubError('timeout', `session did not become active within ${waitActiveSecs}s; the HAPI runner may have failed to spawn`)
  }

  /** Pi sessions need `metadata.piSessionId` before a message is safe (hapi#1143). */
  async function waitForPiReady(sessionId, signal) {
    const deadline = Date.now() + waitActiveSecs * 1_000
    while (Date.now() < deadline) {
      const summary = await getSessionSummary(sessionId, signal)
      const piSessionId = summary?.metadata?.piSessionId
      if (typeof piSessionId === 'string' && piSessionId !== '') return summary
      await sleep(POLL_PI_READY_MS, signal)
    }
    throw new HapiHubError('timeout', `piSessionId never appeared within ${waitActiveSecs}s; refusing to send because the session would wedge`)
  }

  return {
    /** Hub URL this client talks to. */
    apiUrl,
    /** This DSH process's own HAPI session id when it runs under `hapi dsh`. */
    selfSessionId,

    /** List peer sessions, newest update first, excluding this session. */
    async listPeers({ limit } = {}) {
      const clamped = clampListLimit(limit)
      const summaries = await listSessionSummaries({ limit: clamped + 2, order: 'updatedAt' })
      const peers = summaries
        .filter((summary) => summary?.id !== undefined && summary.id !== selfSessionId)
        .sort((left, right) => (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0))
        .slice(0, clamped)
        .map((summary) => ({
          id: String(summary.id),
          active: summary.active === true,
          flavor: typeof summary.metadata?.flavor === 'string' ? summary.metadata.flavor : 'unknown',
          name: sessionLabel(summary),
          ...(typeof summary.updatedAt === 'number' ? { updatedAt: summary.updatedAt } : {}),
        }))
      return peers
    },

    /** Read a peer's metadata and recent message text without resuming it. */
    async inspectPeer({ sessionIdPrefix, messageLimit, signal } = {}) {
      const { summary: listed } = await resolveSession(sessionIdPrefix)
      const sessionId = String(listed.id)
      // HAPI re-reads the session before its messages; keep freshness and the
      // not_found check between the list snapshot and the messages page.
      const summary = await getSessionSummary(sessionId, signal)
      const messages = await fetchMessages(sessionId, messageLimit, signal)
      return {
        sessionId,
        path: `/sessions/${sessionId}`,
        name: sessionLabel(summary),
        flavor: typeof summary.metadata?.flavor === 'string' ? summary.metadata.flavor : 'unknown',
        active: summary.active === true,
        ...(summary.thinking === true ? { thinking: true } : {}),
        ...(typeof summary.metadata?.lifecycleState === 'string' ? { lifecycle: summary.metadata.lifecycleState } : {}),
        ...(typeof summary.metadata?.path === 'string' ? { cwd: summary.metadata.path } : {}),
        ...(typeof summary.updatedAt === 'number' ? { updatedAt: summary.updatedAt } : {}),
        messages,
        truncated: false,
      }
    },

    /** Resume if needed, wait for active, then deliver one message. */
    async pingPeer({ sessionIdPrefix, message, signal } = {}) {
      const body = typeof message === 'string' ? message : ''
      if (body.trim() === '') throw new HapiHubError('bad_args', 'message is required')
      const { summary } = await resolveSession(sessionIdPrefix)
      const sessionId = String(summary.id)
      if (sessionId === selfSessionId) throw new HapiHubError('bad_args', 'ping_peer cannot target the calling session itself')
      let resumed = false

      /** Ensure the session is active, resuming it when necessary. */
      async function ensureActive() {
        let current = await getSessionSummary(sessionId, signal)
        if (current?.active === true) return current
        const resumeResult = await request(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
          method: 'POST',
          body: {},
          signal,
          timeoutMs: RESUME_TIMEOUT_MS,
        })
        if (resumeResult.data?.type !== 'success') {
          const detail = typeof resumeResult.data?.message === 'string'
            ? resumeResult.data.message
            : typeof resumeResult.data?.error === 'string'
              ? resumeResult.data.error
              : typeof resumeResult.data?.code === 'string'
                ? resumeResult.data.code
                : `HTTP ${resumeResult.status}`
          throw new HapiHubError('resume_failed', `resume failed: ${detail}`)
        }
        resumed = true
        current = await waitUntilActive(sessionId, signal)
        return current
      }

      let live = await ensureActive()
      if (live?.metadata?.flavor === 'pi') {
        live = await waitForPiReady(sessionId, signal)
        const resumedBefore = resumed
        live = await ensureActive()
        // A resume during the post-Pi re-check must wait for piSessionId again
        // (hapi#1143) or the first message can wedge the Pi session.
        if (resumed !== resumedBefore && live?.metadata?.flavor === 'pi') {
          live = await waitForPiReady(sessionId, signal)
          live = await ensureActive()
        }
      }
      // A stable localId makes a retried send idempotent on the hub; the 409
      // `session_inactive` response means "resume again, then send once more".
      const localId = randomUUID()
      const postMessage = () => request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: { text: body, localId },
        signal,
        timeoutMs: SEND_TIMEOUT_MS,
      })
      let sendResult = await postMessage()
      if (!sendResult.ok && sendResult.status === 409 && sendResult.data?.code === 'session_inactive') {
        live = await ensureActive()
        sendResult = await postMessage()
      }
      if (!sendResult.ok || sendResult.data?.ok !== true) {
        const detail = typeof sendResult.data?.error === 'string'
          ? sendResult.data.error
          : typeof sendResult.data?.code === 'string'
            ? sendResult.data.code
            : `HTTP ${sendResult.status}`
        throw new HapiHubError('send_failed', `send failed: ${detail}`)
      }
      return { sessionId, name: sessionLabel(live ?? summary), resumed }
    },
  }
}
