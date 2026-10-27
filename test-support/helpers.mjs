/** A controllable promise for concurrency tests, without timing assumptions. */
export function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** One agent with scoped tool/prompt registrations and an observable inbox. */
export function makeAgent(id, { cwd = '/work/proj', origin, status = 'idle', sessionEvents = [] } = {}) {
  const registered = []
  const sections = []
  const collect = (entries, value) => {
    const entry = { agent, ...value, disposed: false, disposeCalls: 0 }
    entries.push(entry)
    return () => {
      entry.disposed = true
      entry.disposeCalls += 1
    }
  }
  const agent = {
    id,
    status,
    session: {
      header: { id, cwd, origin },
      seq: sessionEvents.length,
      snapshotEvents: (start = 0, end = sessionEvents.length) => sessionEvents.slice(start, end),
    },
    steered: [],
    steer(message) { agent.steered.push(message) },
    registered,
    sections,
    ctx: {
      tools: { register: (tool) => collect(registered, { tool }) },
      systemPrompt: { section: (section) => collect(sections, { section }) },
    },
  }
  return agent
}

/** Host services remain configurable; only the context and registry are faked. */
export function makeCtx({ roots = [], services = {}, agents = {} } = {}) {
  const rootAgents = [...roots]
  const known = new Map(roots.map((agent) => [agent.id, agent]))
  const handlers = new Map()
  const effects = []
  const resumeCalls = []
  const logs = { info: [], warn: [] }
  const ctx = {
    agents: {
      roots: agents.roots ?? (() => rootAgents),
      get: agents.get ?? ((id) => known.get(id)),
      async resume(options) {
        resumeCalls.push(options)
        if (typeof agents.resume !== 'function') throw new Error('unexpected manual resume')
        return await agents.resume(options)
      },
    },
    get: (name) => services[name],
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    on(event, handler) {
      const entries = handlers.get(event) ?? []
      entries.push(handler)
      handlers.set(event, entries)
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
    effect(fn, name) { effects.push({ name, dispose: fn() }) },
    addAgent(agent, { root = true } = {}) {
      known.set(agent.id, agent)
      if (root && !rootAgents.includes(agent)) rootAgents.push(agent)
    },
    get registered() { return [...known.values()].flatMap((agent) => agent.registered) },
    get sections() { return [...known.values()].flatMap((agent) => agent.sections) },
    toolsFor(id) {
      return ctx.registered.filter((entry) => entry.agent.id === id && !entry.disposed).map((entry) => entry.tool)
    },
    promptSectionsFor(id) {
      return ctx.sections.filter((entry) => entry.agent.id === id && !entry.disposed).map((entry) => entry.section)
    },
    handlers,
    effects,
    resumeCalls,
    logs,
  }
  return ctx
}

/** In-memory session corpus with call/signal tracking and overridable I/O. */
export function makeSessionQuery(records = [], overrides = {}) {
  const calls = { readSession: [], listSessions: [], readTitle: [], observeSession: [] }
  const disposed = []
  const recordOf = (id) => {
    const record = records.find((entry) => entry.header.id === id)
    if (record === undefined) throw new Error(`stored session not found: ${id}`)
    return record
  }
  return {
    calls,
    disposed,
    async readSession(id, signal) {
      calls.readSession.push({ id, signal })
      if (overrides.readSession !== undefined) return await overrides.readSession(id, signal)
      signal?.throwIfAborted()
      const record = recordOf(id)
      const header = { ...record.header }
      return { session: { header, cwd: header.cwd, createdAt: header.createdAt }, events: record.events ?? [] }
    },
    async listSessions(signal) {
      calls.listSessions.push({ signal })
      if (overrides.listSessions !== undefined) return await overrides.listSessions(signal)
      signal?.throwIfAborted()
      return records.map(({ header, live = false, persisted = true }) => ({ header: { ...header }, live, persisted }))
    },
    async readTitle(id, signal) {
      calls.readTitle.push({ id, signal })
      if (overrides.readTitle !== undefined) return await overrides.readTitle(id, signal)
      signal?.throwIfAborted()
      return { title: recordOf(id).title }
    },
    async observeSession(id, signal) {
      calls.observeSession.push({ id, signal })
      if (overrides.observeSession !== undefined) return await overrides.observeSession(id, signal)
      signal?.throwIfAborted()
      const record = recordOf(id)
      return {
        header: { ...record.header },
        projections: record.projections,
        async [Symbol.asyncDispose]() { disposed.push(id) },
      }
    },
  }
}

/** Controller calls are separate from manual resumes so tests catch wrong routing. */
export function makeSessionController(entries = [], overrides = {}) {
  const calls = { list: [], resolveAgent: [] }
  return {
    calls,
    async list(request, signal) {
      calls.list.push({ request, signal })
      if (overrides.list !== undefined) return await overrides.list(request, signal)
      signal?.throwIfAborted()
      return entries
    },
    async resolveAgent(id, signal) {
      calls.resolveAgent.push({ id, signal })
      if (overrides.resolveAgent !== undefined) return await overrides.resolveAgent(id, signal)
      throw new Error('unexpected controller resume')
    },
  }
}

/** Small service defaults; tests may replace or omit individual capabilities. */
export function makeServices({ records = [], entries = [], titles = {} } = {}) {
  const flushCalls = []
  const titleCalls = []
  const presetCalls = { resolve: [], mount: [] }
  const selection = { provider: 'test-provider', model: 'test-model', reasoningEffort: 'medium' }
  return {
    sessionQuery: makeSessionQuery(records),
    sessionController: makeSessionController(entries),
    sessions: {
      calls: flushCalls,
      async flush(session) { flushCalls.push(session) },
    },
    sessionTitle: {
      calls: titleCalls,
      get(session) {
        titleCalls.push(session)
        return { title: titles[session.header.id] }
      },
    },
    agentPresets: {
      calls: presetCalls,
      async resolve(id) {
        presetCalls.resolve.push(id)
        return typeof id === 'string' ? { id } : undefined
      },
      async mount(ctx, id) { presetCalls.mount.push({ ctx, id }) },
    },
    agentDefaultModel: { currentSelection: () => selection },
  }
}
