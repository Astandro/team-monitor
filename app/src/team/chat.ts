/**
 * Chat with the coordinator (spec-chat, D25).
 *
 * - The owner's message is written by the server to
 *   `<project>/.agent-team/inbox/<sentAt ms, 13 digits>-<id>.json` as
 *   `{"id", "text", "sentAt"}` (temp file, fsync, rename). The server never
 *   writes state.json (A2).
 * - The coordinator copies a message it has read into state.json as
 *   `chat.<id>` = `{"from": "owner", "text", "t": <sentAt>, "readAt"}` and writes
 *   its replies as `chat.<any other id>` = `{"from": "sora", "text", "t"}`.
 * - The server serves `chat`: the state.json entries plus the inbox messages
 *   that are not in state.json yet, sorted by time. Owner entries carry
 *   `status`: "sent" (only in the inbox) or "read" (recorded in state.json).
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { TeamState } from './state-watcher'

export const MAX_MESSAGE_CHARS = 4000
/** 4000 characters of JSON-escaped text fit easily. */
export const MAX_MESSAGE_BODY_BYTES = 32 * 1024
export const MAX_INBOX_FILE_BYTES = 32 * 1024
/** At most this many unread inbox messages are served (newest kept). */
export const MAX_UNREAD_SERVED = 500
export const MESSAGES_PER_MINUTE = 20
export const MESSAGE_ID_RE = /^[0-9a-f]{12}$/
export const INBOX_FILE_RE = /^([0-9]{13})-([0-9a-f]{12})\.json$/
const MAX_FROM_CHARS = 60

export class ChatError extends Error {
  /** `message` goes to the client (no paths); `detail` is for the server log only. */
  constructor(readonly status: 400 | 404 | 429 | 500, message: string, readonly detail?: string) {
    super(message)
  }
}

export interface MessageInput { project: string; text: string }

/** Shape check of the parsed JSON body. Line breaks are kept (CRLF becomes LF), outer whitespace trimmed. */
export function parseMessageBody(body: unknown): MessageInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ChatError(400, 'body must be a JSON object')
  const { project, text } = body as Record<string, unknown>
  if (typeof project !== 'string' || !project) throw new ChatError(400, 'project is required')
  if (typeof text !== 'string') throw new ChatError(400, 'text must be a string')
  const clean = text.replace(/\r\n?/g, '\n').trim()
  if (!clean) throw new ChatError(400, 'text is empty')
  if (clean.length > MAX_MESSAGE_CHARS) throw new ChatError(400, `text is longer than ${MAX_MESSAGE_CHARS} characters`)
  return { project, text: clean }
}

/** Sliding window over accepted messages, for the whole server (one owner). */
export class MessageLimiter {
  private times: number[] = []
  constructor(
    private readonly max = MESSAGES_PER_MINUTE,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until the next message is allowed; 0 = allowed now. */
  retryAfter(): number {
    const t = this.now()
    this.times = this.times.filter((x) => t - x < this.windowMs)
    if (this.times.length < this.max) return 0
    return Math.max(1, Math.ceil((this.times[0] + this.windowMs - t) / 1000))
  }

  record(): void {
    this.times.push(this.now())
  }
}

export interface InboxMessage { id: string; text: string; sentAt: string }

export function inboxFileName(id: string, sentAtMs: number): string {
  if (!MESSAGE_ID_RE.test(id)) throw new ChatError(400, 'bad message id')
  return `${String(Math.max(0, Math.floor(sentAtMs))).padStart(13, '0')}-${id}.json`
}

/** Write one message atomically. Synchronous, so the caller's checks cannot interleave. */
export function writeInboxMessage(
  inboxDir: string,
  text: string,
  now: () => Date = () => new Date(),
): { id: string; sentAt: string; file: string } {
  ensurePlainDir(inboxDir)
  const at = now()
  const sentAt = at.toISOString()
  const id = crypto.randomBytes(6).toString('hex')
  const target = path.join(inboxDir, inboxFileName(id, at.getTime()))
  const data = JSON.stringify({ id, text, sentAt } satisfies InboxMessage, null, 2) + '\n'
  const tmp = path.join(inboxDir, `.${id}.json.${crypto.randomBytes(6).toString('hex')}.tmp`)
  let fd: number | null = null
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, target)
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp) } catch { /* already gone */ }
    throw new ChatError(500, 'cannot save message', `could not write ${target}: ${(e as Error).message}`)
  }
  fsyncDir(inboxDir)
  return { id, sentAt, file: target }
}

function ensurePlainDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (e) {
    throw new ChatError(500, 'cannot save message', `cannot create ${dir}: ${(e as Error).message}`)
  }
  const st = fs.lstatSync(dir)
  // A symlinked inbox could point the write anywhere.
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new ChatError(500, 'cannot save message', `${dir} is not a plain directory (symlink or file)`)
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch { /* not supported everywhere; the rename is already atomic */ }
}

// ─── Reading: inbox, state.json chat, overlay ───────────────────────────────

export interface InboxFile { name: string; id: string; sentAtMs: number }

/** Inbox file names that follow the pattern, oldest first. Temp files and anything else are ignored. */
export function listInbox(inboxDir: string): InboxFile[] {
  let names: string[]
  try { names = fs.readdirSync(inboxDir) } catch { return [] }
  const out: InboxFile[] = []
  for (const name of names.sort()) {
    const m = INBOX_FILE_RE.exec(name)
    if (m) out.push({ name, id: m[2], sentAtMs: Number(m[1]) })
  }
  return out
}

export function readInboxFile(file: string, expectedId: string): InboxMessage | null {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.size > MAX_INBOX_FILE_BYTES) return null
    const r = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<InboxMessage>
    if (r.id !== expectedId || typeof r.text !== 'string' || typeof r.sentAt !== 'string') return null
    return { id: r.id, text: r.text, sentAt: r.sentAt }
  } catch {
    return null
  }
}

function chatMap(state: TeamState | null | undefined): Record<string, unknown> {
  const chat = state?.chat
  return chat && typeof chat === 'object' && !Array.isArray(chat) ? (chat as Record<string, unknown>) : {}
}

/** Ids the coordinator has recorded as read: `chat.<id>.from === "owner"` in state.json. */
export function readMessageIds(state: TeamState | null | undefined): Set<string> {
  const ids = new Set<string>()
  for (const [id, e] of Object.entries(chatMap(state))) {
    if (e && typeof e === 'object' && (e as { from?: unknown }).from === 'owner') ids.add(id)
  }
  return ids
}

/** Inbox messages not recorded in state.json yet, oldest first (at most `MAX_UNREAD_SERVED`, newest kept). */
export function readUnread(inboxDir: string, state: TeamState | null | undefined): InboxMessage[] {
  const read = readMessageIds(state)
  const files = listInbox(inboxDir).filter((f) => !read.has(f.id)).slice(-MAX_UNREAD_SERVED)
  const out: InboxMessage[] = []
  for (const f of files) {
    const m = readInboxFile(path.join(inboxDir, f.name), f.id)
    if (m) out.push(m)
  }
  return out
}

export interface ChatEntry {
  id: string
  /** "owner" for the owner's messages; anything else is the coordinator (normally "sora"). */
  from: string
  text: string
  /** ISO time the message was sent (owner) or written (coordinator). */
  t: string
  /** Owner messages only. */
  status?: 'sent' | 'read'
  /** Owner messages only, when the coordinator recorded it. */
  readAt?: string
}

/**
 * The served thread: state.json `chat` entries plus unread inbox messages,
 * sorted by time (then id). Entries without a usable `from`/`text` are left
 * out; an owner entry without a time takes it from its inbox file name.
 */
export function buildChat(state: TeamState | null | undefined, unread: InboxMessage[], inboxFiles: InboxFile[] = []): ChatEntry[] {
  const fileTime = new Map(inboxFiles.map((f) => [f.id, f.sentAtMs]))
  const out: ChatEntry[] = []
  const seen = new Set<string>()
  for (const [id, raw] of Object.entries(chatMap(state))) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const e = raw as Record<string, unknown>
    if (typeof e.from !== 'string' || !e.from || e.from.length > MAX_FROM_CHARS || typeof e.text !== 'string') continue
    let t = typeof e.t === 'string' ? e.t : ''
    if (!Number.isFinite(Date.parse(t)) && e.from === 'owner' && fileTime.has(id)) t = new Date(fileTime.get(id)!).toISOString()
    const entry: ChatEntry = { id, from: e.from, text: e.text, t }
    if (e.from === 'owner') {
      entry.status = 'read'
      if (typeof e.readAt === 'string') entry.readAt = e.readAt
    }
    out.push(entry)
    seen.add(id)
  }
  for (const m of unread) {
    if (seen.has(m.id)) continue
    out.push({ id: m.id, from: 'owner', text: m.text, t: m.sentAt, status: 'sent' })
  }
  const key = (e: ChatEntry) => { const n = Date.parse(e.t); return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY }
  out.sort((a, b) => key(a) - key(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}
