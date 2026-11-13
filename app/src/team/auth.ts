/**
 * Remote mode access: the token file, login sessions and a failed-login limit.
 *
 * The token (32 random bytes, hex) lives in <home>/token with 0600. It is shown
 * once, when it is created, and never logged again. A login exchanges it for a
 * random session id kept in an HttpOnly cookie; the server stores only a hash
 * of that id (in <home>/sessions.json, 0600) so the phone stays signed in
 * across restarts.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export const SESSION_COOKIE = 'tm_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SESSIONS = 50
const TOKEN_RE = /^[0-9a-f]{64}$/

export class TokenError extends Error {}

export interface TokenResult { token: string; created: boolean; file: string }

/**
 * Load the token, creating it on first run. Tightens wider permissions to 0600
 * and refuses (throws TokenError) when that is not possible.
 */
export function loadOrCreateToken(home: string, fileName = 'token'): TokenResult {
  const file = path.join(home, fileName)
  let st: fs.Stats | null = null
  try { st = fs.lstatSync(file) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new TokenError(`cannot read ${file}: ${(e as Error).message}`)
  }

  if (!st) {
    const token = crypto.randomBytes(32).toString('hex')
    let fd: number
    try {
      fd = fs.openSync(file, 'wx', 0o600)
    } catch (e) {
      throw new TokenError(`cannot create ${file}: ${(e as Error).message}`)
    }
    try {
      fs.writeSync(fd, token + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.chmodSync(file, 0o600)
    return { token, created: true, file }
  }

  if (!st.isFile() || st.isSymbolicLink()) throw new TokenError(`${file} is not a regular file`)
  if ((st.mode & 0o077) !== 0) {
    try { fs.chmodSync(file, 0o600) } catch (e) {
      throw new TokenError(`${file} is readable by others and its mode cannot be fixed: ${(e as Error).message}`)
    }
    if ((fs.statSync(file).mode & 0o077) !== 0) throw new TokenError(`${file} is readable by others; refusing to start`)
  }
  const token = fs.readFileSync(file, 'utf-8').trim()
  if (!TOKEN_RE.test(token)) throw new TokenError(`${file} does not hold a valid token (64 hex characters)`)
  return { token, created: false, file }
}

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s, 'utf-8').digest()
}

/** Constant-time comparison (hashing first makes the lengths equal). */
export function tokenMatches(given: string, token: string): boolean {
  return crypto.timingSafeEqual(sha256(given), sha256(token))
}

/** Fingerprint of the token stored next to the sessions; a different token drops them all. */
export function tokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update('team-monitor-session-binding\0' + token, 'utf-8').digest('hex')
}

/** Key under which a session is stored and tracked (never the id itself). */
export function sessionKey(id: string): string {
  return sha256(id).toString('hex')
}

/**
 * sessions.json: {"token": <fingerprint>, "sessions": {<sha256(id)>: expiresAt}}.
 * Sessions are bound to the token they were issued under: when the token file
 * is replaced (rotation after a lost phone), every stored session is dropped
 * on the next start.
 */
export class SessionStore {
  private sessions = new Map<string, number>() // sha256(id) hex -> expiresAt
  private readonly file: string | null
  private readonly fingerprint: string
  /** Number of stored sessions dropped at load because the token changed. */
  droppedForNewToken = 0

  constructor(home: string | null, token: string, private readonly now: () => number = Date.now) {
    this.file = home ? path.join(home, 'sessions.json') : null
    this.fingerprint = tokenFingerprint(token)
    this.load()
  }

  create(): string {
    const id = crypto.randomBytes(32).toString('base64url')
    this.prune()
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1] - b[1])[0]
      this.sessions.delete(oldest[0])
    }
    this.sessions.set(sessionKey(id), this.now() + SESSION_TTL_MS)
    this.save()
    return id
  }

  isValid(id: string | undefined): boolean {
    return !!id && this.isValidKey(sessionKey(id))
  }

  isValidKey(key: string): boolean {
    const exp = this.sessions.get(key)
    return exp !== undefined && exp > this.now()
  }

  destroy(id: string | undefined): void {
    if (!id) return
    if (this.sessions.delete(sessionKey(id))) this.save()
  }

  private prune(): void {
    const t = this.now()
    for (const [k, exp] of this.sessions) if (exp <= t) this.sessions.delete(k)
  }

  private load(): void {
    if (!this.file) return
    let parsed: { token?: unknown; sessions?: unknown }
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
    } catch {
      return // none yet, or unreadable: start empty
    }
    const stored = parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions as Record<string, unknown> : {}
    const entries = Object.entries(stored).filter(([k, v]) => /^[0-9a-f]{64}$/.test(k) && typeof v === 'number')
    if (parsed?.token !== this.fingerprint) {
      // Issued under another token (or an old file without a binding): drop them all.
      this.droppedForNewToken = entries.length
      this.save()
      return
    }
    for (const [k, v] of entries) this.sessions.set(k, v as number)
    this.prune()
  }

  private save(): void {
    if (!this.file) return
    const tmp = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`
    try {
      const body = { token: this.fingerprint, sessions: Object.fromEntries(this.sessions) }
      fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600, flag: 'wx' })
      fs.renameSync(tmp, this.file)
    } catch {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  }
}

/**
 * Failed-login limit per client, in a sliding window. There is deliberately no
 * global cap: the token has 256 bits, so a global cap would add no protection
 * and would let any tailnet device lock the owner out (review TM-S-05).
 */
export class LoginLimiter {
  private failures = new Map<string, number[]>()

  constructor(
    private readonly perClient = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
    private readonly maxClients = 10_000,
  ) {}

  /** Seconds to wait before trying again, or 0 when a try is allowed. */
  retryAfter(client: string): number {
    const t = this.now()
    const list = this.trim(this.failures.get(client) ?? [], t)
    if (list.length < this.perClient) return 0
    const until = list[list.length - this.perClient] + this.windowMs
    return until > t ? Math.ceil((until - t) / 1000) : 0
  }

  fail(client: string): void {
    const t = this.now()
    this.prune(t)
    const list = this.trim(this.failures.get(client) ?? [], t)
    list.push(t)
    this.failures.delete(client) // re-insert so Map order is "least recently failed first"
    this.failures.set(client, list)
    while (this.failures.size > this.maxClients) {
      this.failures.delete(this.failures.keys().next().value as string)
    }
  }

  /** Number of clients currently tracked (for tests). */
  get size(): number {
    return this.failures.size
  }

  /** Drop clients whose failures are all outside the window. */
  prune(t = this.now()): void {
    for (const [k, list] of this.failures) {
      if (list.every((x) => x <= t - this.windowMs)) this.failures.delete(k)
    }
  }

  succeed(client: string): void {
    this.failures.delete(client)
  }

  private trim(list: number[], t: number): number[] {
    return list.filter((x) => x > t - this.windowMs)
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim()
  }
  return out
}
