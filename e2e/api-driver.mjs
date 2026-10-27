#!/usr/bin/env node
// api-driver.mjs — drive a DSH web instance over its /api Remote RPC surface.
//
// This is the reusable "programmatic session control" client proven on the
// isolated test instance (127.0.0.1:3099). It speaks the same wire protocol the
// Web GUI uses:
//
//   POST http://<host>:<port>/api/<namespace>/<method>
//   content-type: application/json
//   {"type":"client-request","rpcId":"<uuid>","method":"<namespace>/<method>",
//    "payload":{"args":{...}}}
//   => {"type":"server-response","rpcId":"<uuid>",
//       "result":{"ok":true,"value":...} | {"ok":false,"error":{code,message,details}}}
//
// Streaming (session/follow) additionally uses the multiplexed WebSocket at
// ws://<host>:<port>/api/remote.mux with JSON text frames:
//   client -> {"type":"open","streamId":"s1","endpoint":"session/follow","payload":{"args":{...}}}
//   server -> {"type":"item","streamId":"s1","value":<frame>} ... {"type":"end","streamId":"s1"}
//
// No WebSocket dependency: Node >= 22 has a global WebSocket.
//
// Usage:
//   node api-driver.mjs probe                       # GET / + session/list sanity
//   node api-driver.mjs list
//   node api-driver.mjs create [--cwd DIR] [--preset NAME]
//   node api-driver.mjs prompt <sessionId> <text...>
//   node api-driver.mjs turn <sessionId>            # latest turnOutline {prompt,response}
//   node api-driver.mjs reply <sessionId> [--timeout 120]   # poll until the latest turn settles
//   node api-driver.mjs page <sessionId> [--through N] [--max N]
//   node api-driver.mjs follow <sessionId> [--seconds 30]   # live WS session/follow (browse)
//   node api-driver.mjs stream-test [text...]        # create+follow+prompt, live stream to turn/end
//   node api-driver.mjs roundtrip                   # create A+B, prompt A, wait for PONG
//
// Env: DSH_WEB_URL (default http://127.0.0.1:3099), DSH_DRIVER_CWD
//      (default ~/session-bridge-test/workspace for create)
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3099').replace(/\/+$/, '')
const WEB_COOKIE = (process.env.DSH_WEB_COOKIE ?? '').trim()
const WS_BASE = BASE.replace(/^http/i, 'ws')
const DEFAULT_CWD = process.env.DSH_DRIVER_CWD ?? join(homedir(), 'session-bridge-test', 'workspace')

let seq = 0
const calls = []

function log(...a) { console.log(...a) }
function die(msg) { console.error(`api-driver: ${msg}`); process.exit(2) }

async function rpc(endpoint, args, { quiet = false } = {}) {
  const rpcId = `drv-${Date.now()}-${seq++}`
  const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } })
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(WEB_COOKIE === '' ? {} : { cookie: WEB_COOKIE }) },
    body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status} ${text.slice(0, 400)}`)
  const msg = JSON.parse(text)
  if (msg.type !== 'server-response' || msg.rpcId !== rpcId) throw new Error(`${endpoint}: bad response envelope`)
  if (!quiet) calls.push(`POST /api/${endpoint} -> ${msg.result.ok ? 'ok' : msg.result.error.code}`)
  if (!msg.result.ok) {
    const e = msg.result.error
    throw Object.assign(new Error(`${endpoint}: ${e.code}: ${e.message}`), { rpcError: e })
  }
  return msg.result.value
}

const list = async () => (await rpc('session/list', { _request: {} })).items
const projections = sessionId => rpc('session/projections', { request: { sessionId } })

async function createSession(cwd = DEFAULT_CWD, preset = undefined) {
  const request = { cwd }
  if (preset !== undefined) request.agentPreset = preset
  return rpc('session/create', { request })
}

async function prompt(sessionId, text, { mode = 'queue' } = {}) {
  return rpc('session/prompt', { request: {
    requestId: `drv-req-${randomUUID()}`,
    sessionId,
    mode,
    content: [{ type: 'text', text }],
    clientTimeZone: 'Asia/Tokyo',
  } })
}

/** Assistant text blocks of one SessionWireEvent list, newest last. */
function assistantTexts(page) {
  const out = []
  for (const r of page.records ?? []) {
    const e = r.event
    if (e?.type !== 'assistant/message') continue
    for (const block of e.data?.message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out
}

/** Latest page: projections gives the exact cursor that session/page requires. */
async function latestPage(sessionId, maxMessages = 50) {
  const p = await projections(sessionId)
  const through = p?.asOfSeq ?? -1
  const page = await rpc('session/page', { request: {
    address: { kind: 'session', sessionId },
    throughSeq: through,
    maxMessages,
  } })
  return { projections: p, page, through }
}

async function latestTurn(sessionId) {
  const p = await projections(sessionId)
  const outline = p?.values?.turnOutline ?? []
  return { projections: p, turn: outline.at(-1) }
}

/** Poll projections until the newest turn's response is non-empty (or timeout). */
async function waitReply(sessionId, timeoutMs = 120_000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    const { projections: p, turn } = await latestTurn(sessionId)
    last = { projections: p, turn }
    if (turn !== undefined && typeof turn.response === 'string' && turn.response.length > 0) return last
    if (p?.values?.sessionListMetadata?.blank === false) {
      // A blank turn can exist briefly; fall back to raw page if outline is absent.
      const { page } = await latestPage(sessionId)
      const texts = assistantTexts(page)
      if (texts.length > 0) return { projections: p, turn: { prompt: null, response: texts.at(-1) } }
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  const err = new Error(`no assistant reply within ${timeoutMs}ms`)
  err.last = last
  throw err
}

async function follow(sessionId, seconds = 30) {
  const streamId = 's1'
  const WS = globalThis.WebSocket
  if (typeof WS !== 'function') die('global WebSocket unavailable (need Node >= 22)')
  const ws = new WS(`${WS_BASE}/api/remote.mux`)
  const frames = []
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close() } catch {} ; resolve('timeout') }, seconds * 1000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: {
        request: { address: { kind: 'session', sessionId }, maxMessages: 50, assistantStream: true },
      } } }))
    })
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
      frames.push(msg)
      if (msg.type === 'error') { clearTimeout(timer); reject(new Error(JSON.stringify(msg.error))) }
      if (msg.type === 'end') { clearTimeout(timer); resolve('end') }
    })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket error')) })
    ws.addEventListener('close', () => { clearTimeout(timer); resolve('close') })
  })
  await done
  return frames
}

// ---------------------------------------------------------------- commands
const argv = process.argv.slice(2)
const cmd = argv[0]
function flag(name, dflt) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}

try {
  switch (cmd) {
    case 'probe': {
      const root = await fetch(`${BASE}/`)
      log(`GET / -> ${root.status}`)
      const items = await list()
      log(`session/list -> ${items.length} session(s)`)
      log(calls.join('\n'))
      break
    }
    case 'list': {
      const items = await list()
      for (const i of items) log(`${i.sessionId}  blank=${i.blank} running=${i.running} agent=${i.agentAvailable} cwd=${i.cwd ?? ''}`)
      if (items.length === 0) log('(none)')
      break
    }
    case 'create': {
      const r = await createSession(flag('--cwd', DEFAULT_CWD), flag('--preset', undefined))
      log(JSON.stringify(r))
      break
    }
    case 'prompt': {
      const sid = argv[1]; const text = argv.slice(2).filter(a => !a.startsWith('--')).join(' ')
      if (!sid || !text) die('usage: prompt <sessionId> <text...>')
      log(JSON.stringify(await prompt(sid, text)))
      break
    }
    case 'turn': {
      const { turn, projections: p } = await latestTurn(argv[1])
      log(JSON.stringify({ turn, tokenUsage: p?.values?.tokenUsage, asOfSeq: p?.asOfSeq }, null, 2))
      break
    }
    case 'reply': {
      const { turn, projections: p } = await waitReply(argv[1], Number(flag('--timeout', 120_000)))
      log(JSON.stringify({ turn, tokenUsage: p?.values?.tokenUsage }, null, 2))
      break
    }
    case 'page': {
      const sid = argv[1]
      const through = flag('--through', undefined)
      let page
      if (through !== undefined) {
        page = await rpc('session/page', { request: {
          address: { kind: 'session', sessionId: sid }, throughSeq: Number(through), maxMessages: Number(flag('--max', 50)),
        } })
      } else {
        page = (await latestPage(sid, Number(flag('--max', 50)))).page
      }
      for (const r of page.records) log(`seq=${r.event.seq} type=${r.event.type}`)
      const texts = assistantTexts(page)
      if (texts.length) log(`assistant text: ${JSON.stringify(texts.at(-1))}`)
      break
    }
    case 'follow': {
      const frames = await follow(argv[1], Number(flag('--seconds', 30)))
      for (const f of frames) {
        if (f.type === 'item') {
          const v = f.value
          const kind = v?.type ?? '?'
          if (v?.type === 'event') log(`item event seq=${v.event.seq} type=${v.event.type}`)
          else if (v?.type === 'snapshot') log(`item snapshot cursor=${v.cursor} records=${v.records.length}`)
          else if (v?.type === 'assistant-stream') log(`item assistant-stream ${v.frame.type}${v.frame.type === 'chunk' ? ' ' + JSON.stringify(v.frame.chunk).slice(0, 120) : ''}`)
          else log(`item ${kind}`)
        } else log(`${f.type} ${JSON.stringify(f).slice(0, 200)}`)
      }
      break
    }
    case 'stream-test': {
      // Create a session, open session/follow over the WS mux, prompt it, and
      // print the live assistant stream until turn/end. Proves streaming end-to-end.
      const text = argv.slice(1).filter(a => !a.startsWith('--')).join(' ') || 'reply with exactly: PONG'
      const created = await createSession()
      const sessionId = created.sessionId
      log(`session = ${sessionId}`)
      const WS = globalThis.WebSocket
      if (typeof WS !== 'function') die('global WebSocket unavailable (need Node >= 22)')
      const ws = new WS(`${WS_BASE}/api/remote.mux`)
      let finalText = null
      let chunkCount = 0
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stream-test timeout (120s)')), 120_000)
        ws.addEventListener('open', () => {
          log('WS open /api/remote.mux -> session/follow')
          ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: {
            request: { address: { kind: 'session', sessionId }, maxMessages: 50, assistantStream: true },
          } } }))
        })
        ws.addEventListener('message', ev => {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
          if (msg.type === 'error') { clearTimeout(timer); reject(new Error(JSON.stringify(msg.error))); return }
          if (msg.type !== 'item') return
          const v = msg.value
          if (v.type === 'snapshot') {
            log(`snapshot cursor=${v.cursor} records=${v.records.length}`)
            prompt(sessionId, text).then(() => log(`prompt accepted: ${JSON.stringify(text)}`)).catch(reject)
          } else if (v.type === 'assistant-stream') {
            const f = v.frame
            if (f.type === 'start') log('[assistant-stream start]')
            else if (f.type === 'chunk') {
              chunkCount++
              if (f.chunk?.type === 'text-delta') process.stdout.write(f.chunk.text)
            } else if (f.type === 'end') log(`\n[assistant-stream end ${JSON.stringify(f.outcome)}]`)
          } else if (v.type === 'event') {
            if (v.event.type === 'assistant/message') {
              finalText = (v.event.data?.message?.content ?? [])
                .filter(b => b.type === 'text').map(b => b.text).join('')
              log(`event assistant/message seq=${v.event.seq}`)
            }
            if (v.event.type === 'turn/end') { clearTimeout(timer); resolve() }
          }
        })
        ws.addEventListener('close', () => { clearTimeout(timer); resolve() })
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket error')) })
      })
      await done
      try { ws.close() } catch {}
      log(`\nfinal assistant text: ${JSON.stringify(finalText)}`)
      log(`live stream chunks: ${chunkCount}`)
      const expected = /reply with exactly:\s*(.+)$/i.exec(text)?.[1]?.trim()
      const ok = finalText !== null && (expected === undefined || finalText.trim() === expected)
      log(`RESULT: ${finalText !== null && (expected === undefined || finalText.trim() === expected) ? 'PASS' : 'FAIL'}`)
      process.exit(ok ? 0 : 1)
    }
    case 'roundtrip': {
      // The proven loop: two sessions, one short prompt to A, read A's reply.
      const a = await createSession()
      const b = await createSession()
      log(`A = ${a.sessionId} (preset=${a.agentPreset})`)
      log(`B = ${b.sessionId} (preset=${b.agentPreset})`)
      log('prompt A: "reply with exactly: PONG"')
      await prompt(a.sessionId, 'reply with exactly: PONG')
      const { turn, projections: p } = await waitReply(a.sessionId, 120_000)
      log(`A turn: ${JSON.stringify(turn)}`)
      log(`A tokenUsage: ${JSON.stringify(p?.values?.tokenUsage)}`)
      const ok = (turn?.response ?? '').trim() === 'PONG'
      log(`RESULT: ${ok ? 'PASS' : 'FAIL'} (expected exactly PONG)`)
      log(`B untouched: running=${(await list()).find(i => i.sessionId === b.sessionId)?.running}`)
      log(`sessions left behind for cleanup: A=${a.sessionId} B=${b.sessionId}`)
      log('calls:')
      for (const c of calls) log(`  ${c}`)
      process.exit(ok ? 0 : 1)
    }
    default:
      die(`unknown command ${JSON.stringify(cmd ?? '')}; see header for usage`)
  }
} catch (error) {
  console.error(`api-driver: FAILED: ${error.message}`)
  process.exit(1)
}
