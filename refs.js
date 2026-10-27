/**
 * Session-reference parsing shared by the bridge tools and the HAPI hub client.
 *
 * Both HAPI and this plugin accept three reference forms:
 * 1. a bare session id,
 * 2. a unique id prefix,
 * 3. a citation blob containing `/sessions/<id>` (HAPI web copy-reference,
 *    markdown composer chips, or plain prose).
 *
 * A citation blob that contains more than one distinct id fails closed so a
 * caller never messages the wrong session.
 */

const SESSION_PATH_IN_TEXT_RE = /(?:^|[^A-Za-z0-9_-])(?:\.?\/)?(?:[\w.-]+\/)*sessions\/([^/?#\s)\]"']+)/g

/** Decode one `/sessions/<id>` path segment; empty when it cannot be a session id. */
export function decodeCitationId(raw) {
  try {
    // Trailing prose punctuation is stripped; internal dots (file names) reject the id.
    const id = decodeURIComponent(raw).replace(/[.,;:!?]+$/u, '')
    return id.length > 0 && !id.includes('.') ? id : ''
  } catch {
    return ''
  }
}

/** Unique `/sessions/<id>` ids in first-seen order. */
export function extractCitationIds(text) {
  const ids = []
  const seen = new Set()
  SESSION_PATH_IN_TEXT_RE.lastIndex = 0
  let match
  while ((match = SESSION_PATH_IN_TEXT_RE.exec(text)) !== null) {
    const id = decodeCitationId(match[1] ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Normalize a target reference: a bare id/prefix passes through trimmed; a
 * citation blob containing exactly one `/sessions/<id>` yields that id. An
 * ambiguous citation blob yields an empty string.
 */
export function normalizeSessionRef(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (trimmed === '') return ''
  if (!trimmed.includes('/sessions/')) return trimmed
  const ids = extractCitationIds(trimmed)
  return ids.length === 1 ? ids[0] : ''
}

/** True for a canonical DSH session id or bare UUID, with case-insensitive hex. */
export function isFullSessionId(value) {
  return typeof value === 'string' && /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/**
 * Resolve a normalized reference against known session ids. The caller decides
 * how to report each outcome.
 *
 * @param ids - known session ids.
 * @param ref - bare id or unique id prefix.
 * @param options - minimum prefix length, excluding a leading `session-`.
 * @returns `{ id }` on a unique match, `{ ambiguous: ids }` when a prefix has
 *   several matches, `{ tooShort: true }` below the prefix minimum, or
 *   `{ missing: true }` when nothing matches.
 */
export function matchSessionRef(ids, ref, { minPrefixChars = 0 } = {}) {
  const normalized = typeof ref === 'string' ? ref.trim() : ''
  if (ids.includes(normalized)) return { id: normalized }
  const variable = normalized.startsWith('session-') ? normalized.slice('session-'.length) : normalized
  if (variable.length < minPrefixChars) return { tooShort: true }
  if (normalized === '') return { missing: true }
  const matches = ids.filter((id) => id.startsWith(normalized))
  if (matches.length === 1) return { id: matches[0] }
  if (matches.length > 1) return { ambiguous: matches }
  return { missing: true }
}
