/** Configuration and environment parsing without DSH runtime dependencies. */

/** Default cap for one message body, matching DSH's own agent-message budget. */
export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024

/** Normalize a positive byte budget from row config. */
export function messageBudgetOf(config) {
  const configured = config?.maxMessageBytes
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_MESSAGE_BYTES
}

/** HAPI-compatible environment truthiness: only string values 1/true/yes count. */
export function envFlagOn(raw) {
  return typeof raw === 'string' && ['1', 'true', 'yes'].includes(raw.trim().toLowerCase())
}

/** True when the bridge's environment kill switch is on. */
export function disabledByEnv(env = process.env) {
  try {
    return envFlagOn(env?.DSH_SESSION_BRIDGE_DISABLE)
  } catch {
    return false
  }
}

/** True when HAPI's own peer-tool kill switch is on. */
export function hapiPeerToolsDisabledByEnv(env = process.env) {
  try {
    return envFlagOn(env?.HAPI_DISABLE_PEER_TOOLS)
  } catch {
    return false
  }
}

/**
 * Resolve local aliases or hub tools. Auto picks the hub for a hub block or a
 * non-empty CLI_API_TOKEN, as v0.2.1 did; explicit hub mode leaves validation
 * to the client.
 */
export function compatibilityOf(config, env = process.env) {
  if (hapiPeerToolsDisabledByEnv(env)) return null
  const requested = config?.hapiCompat
  if (requested === false || requested === 'none') return null
  if (requested === 'local') return { mode: 'local' }
  const hub = config?.hapiHub
  const configuredHub = hub !== null && typeof hub === 'object' && !Array.isArray(hub)
  if (requested === 'hub') return { mode: 'hub', hub: configuredHub ? hub : {}, explicit: true }
  // HAPI never mirrors CLI_API_TOKEN into wrapped agents, but when a user does
  // export it the default hub URL applies, so a token alone is enough.
  const envHub = typeof env?.CLI_API_TOKEN === 'string' && env.CLI_API_TOKEN.trim() !== ''
  return configuredHub || envHub
    ? { mode: 'hub', hub: configuredHub ? hub : {}, explicit: false }
    : { mode: 'local' }
}
