import { ApiError } from '../api/client'

/** Friendlier wording for codes whose server `detail` is terse or technical. */
const FRIENDLY: Partial<Record<string, string>> = {
  rate_limited: 'Too many attempts. Please wait a moment and try again.',
  puzzle_unavailable:
    'No puzzle is ready for this level right now. Please try again in a few seconds.',
  no_hint_available: 'The board is already complete, so there is nothing left to hint.',
  game_not_in_progress: 'This game is already finished.',
}

/** Human-readable message for any thrown value. */
export function errorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (error instanceof ApiError) {
    const friendly = error.code ? FRIENDLY[error.code] : undefined
    if (friendly) return friendly
    if (error.status === 429) return FRIENDLY.rate_limited ?? fallback
    if (error.status >= 500) return 'The server had a problem. Please try again shortly.'
    return error.message
  }
  if (error instanceof TypeError) return 'Could not reach the server. Check your connection.'
  return fallback
}

/** Friendly text for pydantic messages we expect on our forms. */
function humanize(message: string): string {
  if (/should match pattern/i.test(message)) return 'Use 3–20 letters, digits or underscores.'
  const min = /at least (\d+) characters?/i.exec(message)
  if (min) return `Use at least ${min[1]} characters.`
  if (/not a valid email/i.test(message)) return 'Enter a valid email address.'
  return message
}

/**
 * Field-level messages from a 422 `validation_error`, whose `detail` is
 * "field: message; other.field: message". Also maps field-specific codes.
 */
export function fieldErrors(error: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!(error instanceof ApiError)) return out
  if (
    error.code === 'invalid_username' ||
    error.code === 'username_taken' ||
    error.code === 'username_not_allowed'
  ) {
    out.username = error.message
    return out
  }
  if (error.code !== 'validation_error' || typeof error.detail !== 'string') return out
  for (const part of error.detail.split('; ')) {
    const match = /^([\w.]+): (.+)$/.exec(part)
    const loc = match?.[1]
    const text = match?.[2]
    if (!loc || !text) continue
    const field = loc.split('.').pop() ?? loc
    if (!(field in out)) out[field] = humanize(text)
  }
  return out
}
