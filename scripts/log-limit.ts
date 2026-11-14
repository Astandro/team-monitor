/**
 * Rate limit for log lines a client can cause (hub intake refusals and the like), so a client that repeats a refused
 * request in a loop cannot fill the log.
 *
 * - One line per kind and per source/client (`who`) per interval (default one minute). Lines suppressed in between
 *   are counted, and the count is added to the next line written for that kind and `who`.
 * - At most `perKindPerInterval` lines per kind per interval across all `who` together, so many clients (or many
 *   source ids) cannot add up to unbounded output either. Lines held back by that budget are counted and reported
 *   on the next line of the kind.
 * - At most `maxKeys` kinds-and-who are remembered; the oldest are forgotten first and their unreported counts move
 *   to their kind's count, so no suppressed line goes uncounted.
 *
 * `kind` must be a fixed string from the code (never client data). `who` and the text may hold client data: they
 * are written on one line, control characters replaced and capped in length.
 */

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_PER_KIND = 10
const DEFAULT_MAX_KEYS = 2000
const MAX_WHO_CHARS = 100
const MAX_TEXT_CHARS = 1000

interface Entry { kind: string; last: number; suppressed: number }
interface KindState { windowStart: number; written: number; held: number }

export interface LogLimiterOptions {
  intervalMs?: number
  perKindPerInterval?: number
  maxKeys?: number
  now?: () => number
}

/** Control characters plus the Unicode line and paragraph separators (U+2028, U+2029). */
const LINE_BREAKING = new RegExp(`[\\x00-\\x1f\\x7f${String.fromCharCode(0x2028, 0x2029)}]+`, 'g')

/** One line: control characters (also U+2028/U+2029) become spaces, capped. */
export function oneLine(s: string, max: number): string {
  const cleaned = s.replace(LINE_BREAKING, ' ')
  return cleaned.length > max ? cleaned.slice(0, max) + '...' : cleaned
}

export class LogLimiter {
  private readonly intervalMs: number
  private readonly perKind: number
  private readonly maxKeys: number
  private readonly now: () => number
  /** Per kind and who, in order of the last line written (oldest first). */
  private entries = new Map<string, Entry>()
  private kinds = new Map<string, KindState>()

  constructor(private readonly write: (line: string) => void, opts: LogLimiterOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.perKind = opts.perKindPerInterval ?? DEFAULT_PER_KIND
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS
    this.now = opts.now ?? Date.now
  }

  /** Write `text` unless a line of this kind for this `who` was written within the interval. True when written. */
  line(kind: string, who: string, text: string): boolean {
    const now = this.now()
    const key = JSON.stringify([kind, oneLine(who, MAX_WHO_CHARS)])
    const entry = this.entries.get(key)
    if (entry && now - entry.last < this.intervalMs) {
      entry.suppressed++
      return false
    }
    let k = this.kinds.get(kind)
    if (!k || now - k.windowStart >= this.intervalMs) {
      k = { windowStart: now, written: 0, held: k?.held ?? 0 }
      this.kinds.set(kind, k)
    }
    if (k.written >= this.perKind) {
      k.held++
      return false
    }
    const notes: string[] = []
    const own = entry?.suppressed ?? 0
    if (own > 0) notes.push(`${own} more like it suppressed`)
    if (k.held > 0) notes.push(`${k.held} more of this kind from other sources or clients suppressed`)
    k.held = 0
    k.written++
    this.write(oneLine(text, MAX_TEXT_CHARS) + (notes.length ? ` (${notes.join('; ')})` : ''))
    this.entries.delete(key)
    this.entries.set(key, { kind, last: now, suppressed: 0 })
    this.prune()
    return true
  }

  /** Remembered kinds-and-who (for tests). */
  size(): number {
    return this.entries.size
  }

  /** Over maxKeys: forget the oldest entries; their unreported counts go to their kind's count. */
  private prune(): void {
    for (const [key, e] of this.entries) {
      if (this.entries.size <= this.maxKeys) break
      this.entries.delete(key)
      if (e.suppressed > 0) {
        const k = this.kinds.get(e.kind)
        if (k) k.held += e.suppressed
      }
    }
  }
}
