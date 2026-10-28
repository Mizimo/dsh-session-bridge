#!/usr/bin/env node
// mock-llm.mjs — scripted Anthropic-Messages endpoint that stands in for the
// model when the E2E testbed has no model credentials. Start the test
// instance with DEEPSEEK_BASE_URL=http://127.0.0.1:<port> and any
// DEEPSEEK_API_KEY. Each request is answered from its newest instruction (a
// prompt from bridge-e2e.mjs or a relayed peer message): the tool calls that
// instruction names, then the final text it asks for.
//
// It exercises the plugin and DSH host mechanics only. The discovery phase
// passes because this script knows how to find the peer, not because a model
// chose the tools; use a real model to evaluate tool selection.
//
// Usage: node mock-llm.mjs [port=4011] [logfile]
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 4011)
const logFile = process.argv[3]
let nextId = 1

function log(entry) {
  const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`
  if (logFile) appendFileSync(logFile, line)
  else process.stdout.write(line)
}

/** Text of one Messages content value (string or block list). */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (block?.type === 'text') return block.text
    if (block?.type === 'tool_result') return textOf(block.content)
    return ''
  }).join('\n')
}

/** Text of one user message, or undefined when it carries only tool results. */
function userText(message) {
  if (typeof message.content === 'string') return message.content
  const texts = (message.content ?? []).filter((block) => block?.type === 'text' && block.text.trim() !== '').map((block) => block.text)
  return texts.length === 0 ? undefined : texts.join('\n')
}

/** Newest user message that carries text, plus the assistant tool calls and results after it. */
function conversationState(messages) {
  let instructionIndex = -1
  let instruction = ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = messages[index].role === 'user' ? userText(messages[index]) : undefined
    if (text === undefined) continue
    instructionIndex = index
    instruction = text
    break
  }
  const calls = []
  const results = []
  for (const message of messages.slice(instructionIndex + 1)) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (message.role === 'assistant' && block?.type === 'tool_use') calls.push(block)
      if (message.role === 'user' && block?.type === 'tool_result') results.push(textOf(block.content))
    }
  }
  return { instruction, calls, results }
}

/** Tool steps and final text an instruction asks for; steps may depend on earlier results. */
function plan(instruction, results) {
  const steps = []
  let match
  if (/Call the session_list tool/.test(instruction)) steps.push({ name: 'session_list', input: {} })
  if ((match = instruction.match(/Call session_inspect exactly once with target "([^"]+)"(?: \([^)]*\))? and messageLimit (\d+)/))) {
    steps.push({ name: 'session_inspect', input: { target: match[1], messageLimit: Number(match[2]) } })
  }
  if ((match = instruction.match(/Call (?:the )?session_send(?: tool)? with target "([^"]+)" and message "(.*)"\s*$/m))) {
    steps.push({ name: 'session_send', input: { target: match[1], message: match[2].replace(/\\"/g, '"') } })
  }
  if ((match = instruction.match(/Call session_handoff once with target "([^"]+)", summary "([^"]*)", task "(.*)"\s*$/m))) {
    steps.push({ name: 'session_handoff', input: { target: match[1], summary: match[2], task: match[3] } })
  }
  // Discovery: find the peer by working directory, read it, then message it.
  if (steps.length === 0 && (match = instruction.match(/working directory ends with "([^"]+)"/))) {
    const suffix = match[1]
    steps.push({ name: 'session_list', input: {} })
    if (results.length >= 1) {
      let peer
      try {
        const listed = JSON.parse(results[0])
        peer = [...listed.sessions, ...listed.stored].find((entry) => String(entry.cwd ?? '').endsWith(suffix))
      } catch {
        peer = undefined
      }
      if (peer !== undefined) {
        steps.push({ name: 'session_inspect', input: { target: peer.id } })
        steps.push({ name: 'session_send', input: { target: peer.id, message: 'Please continue with the next step of the login page refactor, then report back to me.' } })
      }
    }
  }
  // A relayed peer message asking for a reply.
  if (steps.length === 0 && (match = instruction.match(/Reply by calling session_send with target "([^"]+)" and message \\?"?([A-Za-z0-9-]+)/))) {
    steps.push({ name: 'session_send', input: { target: match[1], message: match[2] } })
  }
  const final = instruction.match(/reply with only: (\S+)/i)
  let text = final === null ? 'Done.' : final[1]
  if (text === 'PROBE-OK') text = 'PROBE-OK 1'
  return { steps, text }
}

/** Server-sent events of one complete assistant message. */
function sse(blocks, stopReason) {
  const events = [{ type: 'message_start', message: { id: `msg_${nextId++}`, type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${nextId++}`, name: block.name, input: {} } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    }
    events.push({ type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } })
  events.push({ type: 'message_stop' })
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

const server = createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    if (request.method !== 'POST' || !request.url.endsWith('/messages')) {
      log({ unexpected: `${request.method} ${request.url}` })
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock has no such route' } }))
      return
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      response.writeHead(400).end()
      return
    }
    const tools = (body.tools ?? []).map((tool) => tool.name)
    const { instruction, calls, results } = conversationState(body.messages ?? [])
    let blocks
    let stopReason
    if (!tools.includes('session_list')) {
      // Title generation and other tool-less helper calls.
      blocks = [{ type: 'text', text: 'Bridge smoke session' }]
      stopReason = 'end_turn'
    } else {
      const { steps, text } = plan(instruction, results)
      const next = steps[calls.length]
      if (next !== undefined) {
        blocks = [next]
        stopReason = 'tool_use'
      } else {
        blocks = [{ type: 'text', text }]
        stopReason = 'end_turn'
      }
    }
    log({
      session: request.headers['x-deepseek-harness-session-id'],
      tools: tools.length,
      instruction: instruction.slice(-300),
      done: calls.length,
      reply: blocks.map((block) => block.type === 'text' ? `text:${block.text}` : `tool:${block.name} ${JSON.stringify(block.input)}`),
    })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.end(sse(blocks, stopReason))
  })
})

server.listen(port, '127.0.0.1', () => log({ listening: port }))
