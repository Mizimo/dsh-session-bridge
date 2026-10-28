#!/usr/bin/env node
/**
 * bridge-e2e.mjs — end-to-end acceptance test for the dsh-session-bridge plugin.
 *
 * Runs against the isolated DSH web instance (TEST_BASE/home, 127.0.0.1:3099)
 * over the same `/api/<namespace>/<method>` RPC surface the Web GUI uses.
 * Phases:
 *
 *   probe     create A, prompt A to call session_list, dump raw event evidence
 *   discovery human-style request only (no tool names, ids or prefixes): A must
 *             find a peer from session_list, inspect it read-only, then message it
 *   dialogue  A sends B a PING, B replies PONG to A (live, both directions)
 *   handoff   A hands work to B with session_handoff, B reports back
 *   inspect   A sends B a message, then reads B's log with session_inspect
 *             using a unique id prefix (no wake; evidence JSON includes live)
 *   cold-prepare save the target session id before the operator restarts the instance
 *   cold      C inspects the stored session A without waking it, and only
 *             afterwards wakes it through session_send
 *   hapi      A uses the HAPI hub compatibility tools: list_peers, inspect_peer,
 *             ping_peer against a throwaway HAPI session (HAPI_TEST_SESSION_ID),
 *             then the hub API is queried to prove delivery + provenance header
 *
 * State (session ids) is kept in TEST_BASE/logs/bridge-e2e-state.json so phases
 * can run across an instance restart. Every phase prints JSON evidence and
 * exits nonzero on a failed assertion.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const BASE = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3099').replace(/\/+$/, '')
// Stock DSH installs challenge loopback requests with the browser token; the
// testbed scripts pass the session cookie obtained from the `?token=` boot URL.
const WEB_COOKIE = (process.env.DSH_WEB_COOKIE ?? '').trim()
const TEST_BASE = process.env.TEST_BASE ?? join(homedir(), 'session-bridge-test')
const CWD = join(TEST_BASE, 'workspace')
const STATE = join(TEST_BASE, 'logs', 'bridge-e2e-state.json')
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 240_000)

let seq = 0
const calls = []

function log(...args) { console.log(...args) }
function fail(message) { console.error(`bridge-e2e: FAIL: ${message}`); process.exit(1) }
function check(condition, message) { if (!condition) fail(message) }

async function rpc(endpoint, args) {
  const rpcId = `e2e-${Date.now()}-${seq++}`
  const response = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(WEB_COOKIE === '' ? {} : { cookie: WEB_COOKIE }) },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status} ${text.slice(0, 400)}`)
  const message = JSON.parse(text)
  if (message.type !== 'server-response' || message.rpcId !== rpcId) throw new Error(`${endpoint}: bad response envelope`)
  calls.push(`POST /api/${endpoint} -> ${message.result.ok ? 'ok' : message.result.error.code}`)
  if (!message.result.ok) {
    throw Object.assign(new Error(`${endpoint}: ${message.result.error.code}: ${message.result.error.message}`), { rpcError: message.result.error })
  }
  return message.result.value
}

const sessionItems = async () => (await rpc('session/list', { _request: {} })).items
const projectionsOf = (sessionId) => rpc('session/projections', { request: { sessionId } })
async function createSession(cwd = CWD) {
  const created = await rpc('session/create', { request: { cwd } })
  check(typeof created?.sessionId === 'string', 'session/create returned no sessionId')
  return created.sessionId
}
async function promptSession(sessionId, text) {
  return rpc('session/prompt', { request: {
    requestId: `e2e-${randomUUID()}`,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
    clientTimeZone: 'Asia/Tokyo',
  } })
}
async function pageOf(sessionId, maxMessages = 300) {
  const projections = await projectionsOf(sessionId)
  const throughSeq = projections?.asOfSeq ?? 0
  return rpc('session/page', { request: {
    address: { kind: 'session', sessionId }, throughSeq, maxMessages,
  } })
}
const eventsOf = (page) => (page.records ?? []).map((record) => record.event).filter(Boolean)
/**
 * Short id prefix that stays unique for both `session-<uuid>` ids (the scheme
 * itself is shared by every DSH session, so include some uuid chars) and bare
 * uuid ids (HAPI).
 */
function shortPrefix(id, uuidChars = 8) {
  if (id.startsWith('session-')) return id.slice(0, 'session-'.length + uuidChars)
  return id.slice(0, uuidChars)
}

/**
 * Wait until one of a session's committed assistant messages matches `pattern`.
 * Uses the session page, not `turnOutline`: `turnOutline` keeps only the final
 * response of a turn, and a relay consumed mid-turn adds more steps to the same
 * turn, so an intermediate reply ("SENT-A") would otherwise never be visible.
 */
async function waitForAssistantText(sessionId, pattern, label) {
  return waitFor(async () => {
    const page = await pageOf(sessionId)
    return pattern.test(assistantTexts(page).join('\n')) ? page : undefined
  }, { label })
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until predicate returns a truthy value (or timeout). */
async function waitFor(predicate, { label, timeoutMs = TIMEOUT_MS, intervalMs = 500 }) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await predicate()
    if (last !== undefined && last !== null && last !== false) return last
    await sleep(intervalMs)
  }
  fail(`timed out after ${timeoutMs}ms waiting for ${label}${last === undefined ? '' : `; last=${JSON.stringify(last).slice(0, 500)}`}`)
}

/** Assistant message text of one page. */
function assistantTexts(page) {
  const texts = []
  for (const event of eventsOf(page)) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data?.message?.content ?? []) {
      if (block?.type === 'text') texts.push(block.text)
    }
  }
  return texts
}

/** Tool calls (name + parsed args) of one page, from assistant messages. */
function toolCalls(page) {
  const found = []
  for (const event of eventsOf(page)) {
    if (event.type !== 'assistant/message') continue
    for (const block of event.data?.message?.content ?? []) {
      if (block?.type !== 'tool-call') continue
      let args = block.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { /* keep text */ } }
      found.push({ id: block.id, name: block.name, args })
    }
  }
  return found
}

/** Tool results of one page, keyed by call id. */
function toolResults(page) {
  const found = []
  for (const event of eventsOf(page)) {
    if (event.type !== 'tool/result') continue
    const message = event.data?.message ?? event.data
    const text = (message?.content ?? []).map((block) => block?.text ?? '').join('')
    found.push({ callId: message?.toolCallId, isError: message?.isError === true, text })
  }
  return found
}

/** User-role messages delivered into a session, with their source metadata. */
function userMessages(page) {
  const found = []
  for (const event of eventsOf(page)) {
    if (event.type !== 'user/message' && event.type !== 'user/input') continue
    const message = event.data?.message ?? event.data
    const source = message?.source ?? event.data?.source
    found.push({ seq: event.seq, type: event.type, source, message })
  }
  return found
}

function summarizePage(page) {
  return {
    eventTypes: eventsOf(page).map((event) => event.type),
    assistantTexts: assistantTexts(page),
    toolCalls: toolCalls(page).map((call) => ({ name: call.name, args: call.args })),
    userMessages: userMessages(page).map((entry) => ({ seq: entry.seq, type: entry.type, source: entry.source })),
  }
}

async function dumpEvidence(label, sessionId) {
  const page = await pageOf(sessionId)
  log(`--- ${label} (${sessionId}) ---`)
  log(JSON.stringify(summarizePage(page), null, 2))
  const rawUserMessage = eventsOf(page).filter((event) => event.type === 'user/message').at(-1)
  if (rawUserMessage !== undefined) log(`raw user/message: ${JSON.stringify(rawUserMessage).slice(0, 3000)}`)
  return page
}

function loadState() {
  return readFile(STATE, 'utf8').then((text) => JSON.parse(text)).catch(() => ({}))
}
function saveState(state) { return writeFile(STATE, JSON.stringify(state, undefined, 2)) }

// ------------------------------------------------------------------ phases
async function phaseProbe() {
  const before = await sessionItems()
  log(`sessions before: ${before.length}`)
  const a = await createSession()
  log(`A = ${a}`)
  await promptSession(a, 'Call the session_list tool. Then reply with only: PROBE-OK and the number of sessions it returned.')
  const turnPage = await waitForAssistantText(a, /PROBE-OK/, 'A probe turn to settle')
  log(`A probe texts: ${JSON.stringify(assistantTexts(turnPage)).slice(0, 800)}`)
  const page = await dumpEvidence('A probe page', a)
  const names = toolCalls(page).map((call) => call.name)
  check(names.includes('session_list'), `session_list tool was not called; called=${JSON.stringify(names)}. Plugin tools may not be installed.`)
  const results = toolResults(page)
  check(results.some((result) => !result.isError && /"storedTotal"/.test(result.text)), `session_list result is missing the stored-session fields: ${JSON.stringify(results).slice(0, 800)}`)
  log(`session_list result: ${results.find((result) => /storedTotal/.test(result.text))?.text ?? ''}`)
  const text = assistantTexts(page).join('\n')
  check(/PROBE-OK/.test(text), `probe reply missing PROBE-OK: ${JSON.stringify(text)}`)
  await saveState({ a })
  log('PROBE: PASS')
}

/**
 * Human-style discovery: the prompt never names a tool, a session id or a
 * prefix. It only describes the peer's work (a unique working-directory suffix)
 * and asks A to find it, read its progress and message it. This is the phase
 * that proves the shipped tool descriptions + policy section are enough for a
 * model to pick the right tools on its own.
 */
async function phaseDiscovery() {
  const token = randomUUID().slice(0, 8)
  const bCwd = join(CWD, `login-page-${token}`)
  await mkdir(bCwd, { recursive: true })
  const b = await createSession(bCwd)
  log(`B = ${b} (cwd ends with login-page-${token})`)
  await promptSession(b, 'You are the session refactoring the login page. Do not start any work yet. Reply with only: LOGIN-READY')
  await waitForAssistantText(b, /LOGIN-READY/, 'B seed turn')
  const a = await createSession()
  log(`A = ${a}`)

  await promptSession(a, [
    `Another session on this host is refactoring the login page; its working directory ends with "login-page-${token}".`,
    'Find it, check what it has done so far, then ask it to continue with the next step and report back to you.',
    'Do not change any files yourself.',
  ].join('\n'))

  const matchesPeer = (callTarget) => {
    const target = String(callTarget ?? '').trim()
    if (target === '' || target === 'session-') return false
    const strip = (id) => (id.startsWith('session-') ? id.slice('session-'.length) : id)
    return target === b || strip(b).startsWith(strip(target))
  }
  let scopeHintShown = false
  const hintOnScopeError = (page) => {
    if (scopeHintShown) return
    const peerCalls = new Set(toolCalls(page)
      .filter((call) => ['session_inspect', 'session_send', 'session_handoff'].includes(call.name))
      .map((call) => call.id))
    const blocked = toolResults(page).some((result) => peerCalls.has(result.callId)
      && ((result.isError && /scope|workspace|permission|access denied/i.test(result.text))
        || /"redacted"\s*:\s*true/.test(result.text)))
    if (!blocked) return
    scopeHintShown = true
    log('DISCOVERY: scope/permission restriction detected. A and B intentionally use different workspaces; this phase needs the default scope: host. Remove the same-cwd/same-root scope from the isolated session-bridge profile row (or add allowCwds covering TEST_BASE/workspace), restart the instance, and rerun discovery.')
  }
  const discovered = await waitFor(async () => {
    const page = await pageOf(a)
    hintOnScopeError(page)
    const calls = toolCalls(page)
    const deliver = calls.find((call) => (call.name === 'session_send' || call.name === 'session_handoff') && matchesPeer(call.args?.target))
    return deliver === undefined ? undefined : { page, calls, deliver }
  }, { label: 'A to discover B and message it from a human-style request' })
  const names = discovered.calls.map((call) => call.name)
  log(`A tool sequence: ${JSON.stringify(names)}`)
  check(names.includes('session_list'), `A never called session_list; sequence=${JSON.stringify(names)}`)
  check(names.includes('session_inspect'), `A messaged without a read-only look first; sequence=${JSON.stringify(names)}`)
  const inspectAt = names.indexOf('session_inspect')
  const deliverAt = names.indexOf(discovered.deliver.name)
  check(inspectAt !== -1 && inspectAt < deliverAt, `A messaged before inspecting the peer; sequence=${JSON.stringify(names)}`)
  const inspected = discovered.calls.find((call) => call.name === 'session_inspect')
  check(matchesPeer(inspected?.args?.target), `A inspected something other than B: ${JSON.stringify(inspected?.args)}`)
  log(`discovery call: ${discovered.deliver.name} args=${JSON.stringify(discovered.deliver.args).slice(0, 500)}`)

  const bPage = await waitFor(async () => {
    const page = await pageOf(b)
    if (userMessages(page).some((entry) => entry.source?.kind === 'agent-message' && entry.source?.senderSessionId === a)) return page
    // The send result may be committed after the call was first observed.
    if (!scopeHintShown) hintOnScopeError(await pageOf(a))
    return undefined
  }, { label: 'B to receive the discovered message' })
  const relay = userMessages(bPage).find((entry) => entry.source?.kind === 'agent-message' && entry.source?.senderSessionId === a)
  const relayText = JSON.stringify(relay.message ?? '')
  check(relayText.includes('[session-bridge]'), `relayed message is missing the bridge marker: ${relayText.slice(0, 600)}`)
  check(relayText.includes(token) || /login/i.test(relayText), `relayed message does not reference the login-page task; got: ${relayText.slice(0, 600)}`)
  await dumpEvidence('A discovery page', a)
  await dumpEvidence('B received message', b)
  await saveState({ a, b })
  log('DISCOVERY: PASS')
}

async function phaseDialogue() {
  const a = await createSession()
  const b = await createSession()
  log(`A = ${a}\nB = ${b}`)
  await promptSession(a, [
    'You are testing the cross-session bridge.',
    `1. Call the session_send tool with target ${JSON.stringify(b)} and message "PING from session A. Reply by calling session_send with target ${JSON.stringify(a)} and message \\"PONG\\"."`,
    '2. Then reply with only: SENT-A',
  ].join('\n'))
  const aTurnPage = await waitForAssistantText(a, /SENT-A/, 'A dialogue turn')
  log(`A dialogue texts: ${JSON.stringify(assistantTexts(aTurnPage)).slice(0, 600)}`)
  const aPage = await dumpEvidence('A after sending', a)
  const aCalls = toolCalls(aPage)
  check(aCalls.some((call) => call.name === 'session_send' && call.args?.target === b), `A did not call session_send to B: ${JSON.stringify(aCalls)}`)

  // B must receive the relayed message and answer by calling session_send back to A.
  const bTurnPage = await waitForAssistantText(b, /./, 'B reply turn')
  log(`B texts: ${JSON.stringify(assistantTexts(bTurnPage)).slice(0, 600)}`)
  const bPage = await dumpEvidence('B after reply', b)
  const bInbound = userMessages(bPage).filter((entry) => entry.source?.kind === 'agent-message' && entry.source?.senderSessionId === a)
  check(bInbound.length > 0, `B did not receive an agent-message from A: ${JSON.stringify(userMessages(bPage).map((e) => e.source))}`)
  const bCalls = toolCalls(bPage)
  check(bCalls.some((call) => call.name === 'session_send' && call.args?.target === a), `B did not reply with session_send to A: ${JSON.stringify(bCalls)}`)

  // A must be woken by B's reply and see it as an agent-message from B.
  await waitFor(async () => {
    const page = await pageOf(a)
    return userMessages(page).some((entry) => entry.source?.kind === 'agent-message' && entry.source?.senderSessionId === b) ? page : undefined
  }, { label: 'A to receive B reply' })
  // The relay is consumed at A's next step boundary, which can be inside the
  // same turn; wait until A has committed assistant output *after* the inbound
  // message instead of sampling once right after the inbound row appears.
  const aAfter = await waitFor(async () => {
    const page = await pageOf(a)
    const inbound = userMessages(page).filter((entry) => entry.source?.kind === 'agent-message' && entry.source?.senderSessionId === b).at(-1)
    if (inbound === undefined) return undefined
    const assistantSeqs = eventsOf(page).filter((event) => event.type === 'assistant/message').map((event) => event.seq)
    const lastAssistantSeq = assistantSeqs.length === 0 ? -1 : Math.max(...assistantSeqs)
    return lastAssistantSeq > inbound.seq ? page : undefined
  }, { label: 'A to produce output after B relay' })
  await dumpEvidence('A after receiving PONG', a)
  const inbound = userMessages(aAfter).filter((entry) => entry.source?.kind === 'agent-message' && entry.source?.senderSessionId === b).at(-1)
  check(inbound !== undefined, 'A never received the agent-message from B')
  await saveState({ a, b })
  log('DIALOGUE: PASS')
}

async function phaseHandoff() {
  const { a, b } = await loadState()
  check(typeof a === 'string' && typeof b === 'string', 'dialogue state missing; run the dialogue phase first')
  await promptSession(a, [
    'Hand off work with the session_handoff tool.',
    `Call session_handoff once with target ${JSON.stringify(b)}, summary "Ping/Pong dialogue test finished", task "Reply by calling session_send with target ${JSON.stringify(a)} and message HANDOFF-OK."`,
    'Then reply with only: HANDOFF-SENT',
  ].join('\n'))
  await waitFor(async () => {
    const page = await pageOf(a)
    return toolCalls(page).some((call) => call.name === 'session_handoff' && call.args?.target === b) ? page : undefined
  }, { label: 'A session_handoff tool call' })
  const aPage = await dumpEvidence('A after handoff', a)
  const handoffCall = toolCalls(aPage).find((call) => call.name === 'session_handoff')
  check(handoffCall !== undefined, 'no session_handoff call recorded')

  await waitFor(async () => {
    const page = await pageOf(b)
    const inbound = userMessages(page).filter((entry) => entry.source?.kind === 'agent-message' && entry.source?.senderSessionId === a)
    return inbound.some((entry) => JSON.stringify(entry.message ?? '').includes('Ping/Pong dialogue test finished')) ? page : undefined
  }, { label: 'B to receive the handoff body' })
  const bPage = await dumpEvidence('B after handoff delivery', b)
  check(JSON.stringify(bPage).includes('HANDOFF-OK'), 'handoff task text not delivered to B')

  // B reports back with session_send({ target: A }); that tool call is recorded
  // in B's page, and the relayed message lands in A's page.
  await waitFor(async () => {
    const page = await pageOf(a)
    return userMessages(page).some((entry) => entry.source?.kind === 'agent-message'
      && entry.source?.senderSessionId === b
      && /HANDOFF-OK/.test(JSON.stringify(entry.message ?? ''))) ? page : undefined
  }, { label: 'A to receive HANDOFF-OK from B' })
  const bReported = await pageOf(b)
  check(toolCalls(bReported).some((call) => call.name === 'session_send' && call.args?.target === a && /HANDOFF-OK/.test(String(call.args?.message))), 'B page does not show the session_send(HANDOFF-OK) tool call')
  await dumpEvidence('A after handoff report', a)
  log('HANDOFF: PASS')
}

async function phaseInspect() {
  const a = await createSession()
  const b = await createSession()
  log(`A = ${a}\nB = ${b}`)
  await promptSession(a, [
    'You are testing session_inspect (read-only peer log inspection).',
    `1. Call session_send with target ${JSON.stringify(b)} and message "INSPECT-PING. Reply by calling session_send with target ${JSON.stringify(a)} and message INSPECT-PONG."`,
    '2. Then reply with only: INSPECT-SENT',
  ].join('\n'))
  await waitForAssistantText(a, /INSPECT-SENT/, 'A inspect setup turn')
  // B must have consumed the relay before the read can see it.
  await waitFor(async () => {
    const page = await pageOf(b)
    return userMessages(page).some((entry) => entry.source?.kind === 'agent-message' && entry.source?.senderSessionId === a) ? page : undefined
  }, { label: 'B inbound relay before inspect' })

  const prefix = shortPrefix(b)
  await promptSession(a, [
    `Call session_inspect exactly once with target ${JSON.stringify(prefix)} (the id prefix of B) and messageLimit 10.`,
    `Then reply with only: INSPECT-OK-${prefix}`,
  ].join('\n'))
  await waitForAssistantText(a, /INSPECT-OK-/, 'A inspect turn')
  const page = await dumpEvidence('A after session_inspect', a)
  const calls = toolCalls(page)
  check(
    calls.some((call) => call.name === 'session_inspect' && String(call.args?.target ?? '').startsWith(prefix)),
    `A did not call session_inspect with B's id prefix: ${JSON.stringify(calls.map((call) => ({ name: call.name, args: call.args })))}`,
  )
  const inspectResult = toolResults(page).filter((result) => /"session"/.test(result.text) && /"messages"/.test(result.text)).at(-1)
  check(inspectResult !== undefined && inspectResult.isError !== true, 'session_inspect returned an error result')
  const parsed = JSON.parse(inspectResult.text)
  check(parsed.session?.id === b, `session_inspect resolved the wrong session: ${inspectResult.text.slice(0, 400)}`)
  check(parsed.session?.live === true, 'session_inspect did not report the live target as live')
  check(parsed.messages.length > 0, 'session_inspect returned no message text')
  check(parsed.messages.some((message) => message.fromAgent === true && /INSPECT-PING/.test(message.text)), 'session_inspect did not mark the relayed message as from an agent')
  check(parsed.messages.some((message) => message.role === 'assistant'), 'session_inspect found no assistant text')
  log(`session_inspect: ${JSON.stringify({ id: parsed.session.id, live: parsed.session.live, messages: parsed.messages.length, fromAgent: parsed.messages.filter((m) => m.fromAgent).length })}`)
  await saveState({ a, b, inspectTarget: b })
  log('INSPECT: PASS')
}

async function phaseHapi() {
  const target = (process.env.HAPI_TEST_SESSION_ID ?? '').trim()
  check(target !== '', 'HAPI_TEST_SESSION_ID is required for the hapi phase (throwaway HAPI dsh session)')
  const prefix = target.slice(0, 8)
  const apiUrl = (process.env.HAPI_API_URL ?? 'http://127.0.0.1:3006').replace(/\/+$/, '')
  const accessToken = (process.env.CLI_API_TOKEN ?? '').trim()
  check(accessToken !== '', 'CLI_API_TOKEN is required in the e2e environment for the hub verification step')

  // Pre-flight the target straight on the hub: fail loudly with the real state
  // instead of misreading a resume failure later as a ping_peer bug.
  const authResponse = await fetch(`${apiUrl}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken }),
  })
  check(authResponse.ok, `hub auth failed: HTTP ${authResponse.status}`)
  const jwt = (await authResponse.json()).token
  check(typeof jwt === 'string' && jwt !== '', 'hub auth returned no token')
  const authHeaders = { authorization: `Bearer ${jwt}` }
  const targetResponse = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(target)}`, { headers: authHeaders })
  const targetBody = await targetResponse.json().catch(() => ({}))
  check(targetResponse.ok && targetBody?.session !== undefined, `HAPI target session not found: HTTP ${targetResponse.status} ${JSON.stringify(targetBody).slice(0, 300)}`)
  log(`HAPI target: active=${targetBody.session.active} flavor=${targetBody.session.metadata?.flavor} name=${targetBody.session.metadata?.name ?? ''}`)

  const a = await createSession()
  log(`A = ${a}\nHAPI target = ${target} (prefix ${prefix})`)
  await promptSession(a, [
    'You are testing the HAPI hub compatibility tools of the session bridge.',
    `1. Call list_peers with limit 100 and find the peer session whose id starts with ${JSON.stringify(prefix)}.`,
    `2. Call inspect_peer with sessionIdPrefix ${JSON.stringify(prefix)} and messageLimit 5.`,
    `3. Call ping_peer with sessionIdPrefix ${JSON.stringify(prefix)} and message "HAPI-PING from bridge E2E. Reply with HAPI-PONG."`,
    'Then reply with only: HAPI-OK',
  ].join('\n'))
  await waitForAssistantText(a, /HAPI-OK/, 'A HAPI tools turn')
  const page = await dumpEvidence('A after HAPI peer tools', a)
  const calls = toolCalls(page)
  check(calls.some((call) => call.name === 'list_peers'), 'A did not call list_peers')
  check(
    calls.some((call) => call.name === 'inspect_peer' && String(call.args?.sessionIdPrefix ?? '').startsWith(prefix)),
    'A did not call inspect_peer with the HAPI target prefix',
  )
  check(
    calls.some((call) => call.name === 'ping_peer' && String(call.args?.sessionIdPrefix ?? '').startsWith(prefix)),
    'A did not call ping_peer with the HAPI target prefix',
  )
  const results = toolResults(page)
  const evidence = () => JSON.stringify(results.map((result) => ({ isError: result.isError, text: result.text.slice(0, 600) })))
  const listResult = results.find((result) => /"peers":/.test(result.text))
  check(listResult !== undefined && listResult.isError !== true, `list_peers returned an error result: ${evidence()}`)
  const listed = JSON.parse(listResult.text)
  check(listed.peers.some((peer) => peer.id === target), `list_peers did not include the HAPI target ${target}: ${evidence()}`)
  const inspectResult = results.find((result) => /"path":"\/sessions\//.test(result.text))
  check(inspectResult !== undefined && inspectResult.isError !== true, `inspect_peer returned an error result: ${evidence()}`)
  const inspected = JSON.parse(inspectResult.text)
  check(inspected.sessionId === target, `inspect_peer resolved the wrong session: ${inspectResult.text.slice(0, 400)}`)
  const pingResult = results.find((result) => /"delivered":\s*true/.test(result.text))
  check(pingResult !== undefined && pingResult.isError !== true, `ping_peer returned an error result: ${evidence()}`)
  const pinged = JSON.parse(pingResult.text)
  check(pinged.sessionId === target, `ping_peer resolved the wrong session: ${pingResult.text.slice(0, 400)}`)
  log(`HAPI tool results: list=${listed.peers.length} peers, inspect=${inspected.messages.length} messages, ping resumed=${pinged.resumed}`)

  // Prove delivery and provenance directly on the hub (token stays in memory).
  let deliveredText
  let lastStatus = 'not fetched'
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && deliveredText === undefined) {
    const response = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(target)}/messages?limit=200`, { headers: authHeaders })
    if (!response.ok) {
      lastStatus = `HTTP ${response.status} ${(await response.text()).slice(0, 300)}`
      fail(`hub messages read failed for ${target}: ${lastStatus}`)
    }
    const data = await response.json().catch(() => ({}))
    const rows = Array.isArray(data?.messages) ? data.messages : []
    const text = rows.map((row) => JSON.stringify(row.content ?? '')).join('\n')
    if (/HAPI-PING from bridge E2E/.test(text)) deliveredText = text
    else {
      lastStatus = `last page has ${rows.length} messages`
      await sleep(2000)
    }
  }
  check(deliveredText !== undefined, `the HAPI target session never received the ping message on the hub (${lastStatus})`)
  check(/\[session-bridge\]/.test(deliveredText), 'the HAPI message is missing the bridge provenance marker')
  check(/automated agent-to-agent message/.test(deliveredText), 'the HAPI message is missing the agent-provenance sentence')
  check(deliveredText.includes(a), 'the HAPI message does not name the sending DSH session id')
  log('HAPI: PASS')
}

async function phaseColdPrepare() {
  const { a, b } = await loadState()
  check(typeof a === 'string', 'no stored A session; run the dialogue phase first')
  const live = await sessionItems()
  log(`sessions before restart: ${live.length}`)
  await saveState({ a, b, coldTarget: a })
  log(`COLD-PREPARE: stored target A=${a}. Restart the instance now, then run the cold phase.`)
}

async function phaseCold() {
  const state = await loadState()
  const target = state.coldTarget ?? state.a
  check(typeof target === 'string', 'no cold target stored')
  const live = await sessionItems()
  const targetItem = live.find((item) => item.sessionId === target)
  log(`cold target ${target}: agentAvailable=${targetItem?.agentAvailable} running=${targetItem?.running}`)
  check(targetItem !== undefined, 'cold target session disappeared from session/list')
  check(targetItem.agentAvailable !== true, `target ${target} is still live; cold path was not exercised`)

  const c = await createSession()
  log(`C = ${c}`)

  // Read the stored session first: this must NOT wake it.
  await promptSession(c, [
    `Call session_inspect exactly once with target ${JSON.stringify(target)} and messageLimit 5.`,
    'Then reply with only: INSPECTED-COLD',
  ].join('\n'))
  await waitForAssistantText(c, /INSPECTED-COLD/, 'C cold inspect turn')
  const inspectPage = await dumpEvidence('C after cold session_inspect', c)
  const inspectResult = toolResults(inspectPage).filter((result) => /"session"/.test(result.text) && /"live"/.test(result.text)).at(-1)
  check(inspectResult !== undefined && inspectResult.isError !== true, 'cold session_inspect returned an error result')
  const inspected = JSON.parse(inspectResult.text)
  check(inspected.session.id === target, 'cold session_inspect resolved the wrong session')
  check(inspected.session.live === false, 'cold session_inspect should report the stored target as not live')
  check(inspected.messages.length > 0, 'cold session_inspect returned no message text')
  const stillCold = await sessionItems()
  check(stillCold.find((item) => item.sessionId === target)?.agentAvailable !== true, 'session_inspect woke the stored session')
  log(`cold inspect: live=${inspected.session.live} messages=${inspected.messages.length}; target still cold`)

  await promptSession(c, [
    `Call the session_send tool with target ${JSON.stringify(target)} and message "COLD-PING. Reply by calling session_send with target ${JSON.stringify(c)} and message COLD-PONG."`,
    'Then reply with only: SENT-C',
  ].join('\n'))
  const cCalls = await waitFor(async () => {
    const page = await pageOf(c)
    const callsFound = toolCalls(page).filter((call) => call.name === 'session_send' && call.args?.target === target)
    return callsFound.length > 0 ? callsFound : undefined
  }, { label: 'C session_send call' })
  log(`C tool call: ${JSON.stringify(cCalls[0])}`)
  const sendResultPage = await waitFor(async () => {
    const page = await pageOf(c)
    return JSON.stringify(page).includes('coldResumed') ? page : undefined
  }, { label: 'C session_send coldResumed result' })
  check(JSON.stringify(sendResultPage).includes('coldResumed'), 'session_send result is missing coldResumed evidence in the session page')

  // The plugin should have cold-resumed the stored session and delivered the message.
  const resumed = await waitFor(async () => {
    const items = await sessionItems()
    const item = items.find((entry) => entry.sessionId === target)
    return item?.agentAvailable === true ? item : undefined
  }, { label: 'cold target to be resumed by the plugin' })
  log(`resumed target: ${JSON.stringify(resumed)}`)
  const targetPage = await dumpEvidence('cold target after wake', target)
  check(userMessages(targetPage).some((entry) => entry.source?.kind === 'agent-message' && entry.source?.senderSessionId === c), 'cold target received no agent-message from C')
  // A cold wake resumes the agent and then runs a full turn; give it time to reply.
  const replied = await waitFor(async () => {
    const page = await pageOf(target)
    return toolCalls(page).some((call) => call.name === 'session_send' && call.args?.target === c) ? page : undefined
  }, { label: 'cold target to reply to C' })
  check(toolCalls(replied).some((call) => call.name === 'session_send' && call.args?.target === c), 'cold target did not reply to C')

  // C should receive the cold target's reply.
  await waitFor(async () => {
    const page = await pageOf(c)
    return userMessages(page).some((entry) => entry.source?.kind === 'agent-message' && entry.source?.senderSessionId === target) ? page : undefined
  }, { label: 'C to receive cold-target reply' })
  await dumpEvidence('C after cold reply', c)
  log('COLD: PASS')
}

// --------------------------------------------------------------- dispatch
const phase = process.argv[2]
try {
  switch (phase) {
    case 'probe': await phaseProbe(); break
    case 'discovery': await phaseDiscovery(); break
    case 'dialogue': await phaseDialogue(); break
    case 'handoff': await phaseHandoff(); break
    case 'inspect': await phaseInspect(); break
    case 'cold-prepare': await phaseColdPrepare(); break
    case 'cold': await phaseCold(); break
    case 'hapi': await phaseHapi(); break
    default:
      console.error('usage: bridge-e2e.mjs <probe|discovery|dialogue|handoff|inspect|cold-prepare|cold|hapi>')
      process.exit(2)
  }
  log(`rpc calls: ${calls.length}`)
  process.exit(0)
} catch (error) {
  console.error(`bridge-e2e: ERROR: ${error?.message ?? error}`)
  if (error?.stack) console.error(error.stack.split('\n').slice(0, 4).join('\n'))
  process.exit(1)
}
