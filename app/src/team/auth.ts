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
export function loadOrCreateToken(home: string): TokenResult {
  const file = path.join(home, 'token')
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

export class SessionStore {
  private sessions = new Map<string, number>() // sha256(id) hex -> expiresAt
  private readonly file: string | null

  constructor(home: string | null, private readonly now: () => number = Date.now) {
    this.file = home ? path.join(home, 'sessions.json') : null
    this.load()
  }

  create(): string {
    const id = crypto.randomBytes(32).toString('base64url')
    this.prune()
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1] - b[1])[0]
      this.sessions.delete(oldest[0])
    }
    this.sessions.set(sha256(id).toString('hex'), this.now() + SESSION_TTL_MS)
    this.save()
    return id
  }

  isValid(id: string | undefined): boolean {
    if (!id) return false
    const exp = this.sessions.get(sha256(id).toString('hex'))
    return exp !== undefined && exp > this.now()
  }

  destroy(id: string | undefined): void {
    if (!id) return
    if (this.sessions.delete(sha256(id).toString('hex'))) this.save()
  }

  private prune(): void {
    const t = this.now()
    for (const [k, exp] of this.sessions) if (exp <= t) this.sessions.delete(k)
  }

  private load(): void {
    if (!this.file) return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, unknown>
      for (const [k, v] of Object.entries(parsed)) {
        if (/^[0-9a-f]{64}$/.test(k) && typeof v === 'number') this.sessions.set(k, v)
      }
      this.prune()
    } catch { /* none yet, or unreadable: start empty */ }
  }

  private save(): void {
    if (!this.file) return
    const tmp = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600, flag: 'wx' })
      fs.renameSync(tmp, this.file)
    } catch {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  }
}

/** Failed-login limit: per client address and overall, in a sliding window. */
export class LoginLimiter {
  private failures = new Map<string, number[]>()
  private global: number[] = []

  constructor(
    private readonly perClient = 5,
    private readonly overall = 20,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds to wait before trying again, or 0 when a try is allowed. */
  retryAfter(client: string): number {
    const t = this.now()
    const list = this.trim(this.failures.get(client) ?? [], t)
    this.global = this.trim(this.global, t)
    let until = 0
    if (list.length >= this.perClient) until = list[list.length - this.perClient] + this.windowMs
    if (this.global.length >= this.overall) until = Math.max(until, this.global[this.global.length - this.overall] + this.windowMs)
    return until > t ? Math.ceil((until - t) / 1000) : 0
  }

  fail(client: string): void {
    const t = this.now()
    const list = this.trim(this.failures.get(client) ?? [], t)
    list.push(t)
    this.failures.set(client, list)
    this.global.push(t)
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
