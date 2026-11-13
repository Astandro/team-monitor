/**
 * Watches one project's `.agent-team/` folder and keeps the parsed team state.
 *
 * - fs.watch on `.agent-team/` and `.agent-team/answers/`, plus a slow poll as
 *   fallback (fs.watch misses events on some filesystems and cannot watch a
 *   folder that does not exist yet). Events are debounced.
 * - state.json is capped at 1 MB. On a parse error the last good state is kept
 *   and `error` is set.
 * - Answers in `answers/<Dn>.json` are overlaid onto open approvals. The server
 *   never writes state.json (architecture call A2).
 */
import * as fs from 'fs'
import * as path from 'path'
import { agentTeamDir } from './config'

export const MAX_STATE_BYTES = 1024 * 1024
export const MAX_ANSWER_FILE_BYTES = 16 * 1024
export const ANSWER_FILE_RE = /^(D[0-9]{1,4})\.json$/

export type TeamState = Record<string, unknown>

export interface TeamSnapshot {
  project: string
  state: TeamState | null
  error: string | null
  updatedAt: string
}

export interface AnswerRecord { answer: string; answeredAt: string }

export interface WatcherOptions {
  projectId: string
  projectPath: string
  debounceMs?: number
  pollMs?: number
}

type Listener = (snap: TeamSnapshot) => void

export class TeamStateWatcher {
  readonly projectId: string
  readonly dir: string
  readonly answersDir: string
  private readonly debounceMs: number
  private readonly pollMs: number

  private raw: TeamState | null = null
  private error: string | null = null
  private answers = new Map<string, AnswerRecord>()
  private updatedAt = new Date().toISOString()
  private lastPayload = ''
  private lastSignature = ''

  private listeners = new Set<Listener>()
  private dirWatcher: fs.FSWatcher | null = null
  private answersWatcher: fs.FSWatcher | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(opts: WatcherOptions) {
    this.projectId = opts.projectId
    this.dir = agentTeamDir(opts.projectPath)
    this.answersDir = path.join(this.dir, 'answers')
    this.debounceMs = opts.debounceMs ?? 100
    this.pollMs = opts.pollMs ?? 3000
  }

  start(): void {
    this.reload()
    this.attachWatchers()
    this.pollTimer = setInterval(() => {
      this.attachWatchers()
      this.reloadIfChanged()
    }, this.pollMs)
    this.pollTimer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.dirWatcher?.close()
    this.answersWatcher?.close()
    this.dirWatcher = this.answersWatcher = null
    this.listeners.clear()
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** State as served: answers overlaid on approvals. */
  snapshot(): TeamSnapshot {
    return { project: this.projectId, state: this.overlaid(), error: this.error, updatedAt: this.updatedAt }
  }

  /** State exactly as the coordinator wrote it (last good parse). */
  rawState(): TeamState | null {
    return this.raw
  }

  /** Re-read now (used right after the server writes an answer). */
  refresh(): void {
    this.reload()
  }

  private attachWatchers(): void {
    if (this.disposed) return
    if (!this.dirWatcher) this.dirWatcher = this.tryWatch(this.dir, () => { this.dirWatcher = null })
    if (!this.answersWatcher) this.answersWatcher = this.tryWatch(this.answersDir, () => { this.answersWatcher = null })
  }

  private tryWatch(dir: string, onGone: () => void): fs.FSWatcher | null {
    try {
      const w = fs.watch(dir, { persistent: false }, () => this.schedule())
      w.on('error', () => { w.close(); onGone() })
      return w
    } catch {
      return null
    }
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.reload()
    }, this.debounceMs)
  }

  /** Cheap check for the poll: only reload when a file's size or mtime moved. */
  private signature(): string {
    const parts: string[] = []
    const statPart = (p: string) => {
      try { const s = fs.statSync(p); parts.push(`${p}:${s.size}:${s.mtimeMs}`) } catch { parts.push(`${p}:-`) }
    }
    statPart(path.join(this.dir, 'state.json'))
    try {
      for (const name of fs.readdirSync(this.answersDir).sort()) {
        if (ANSWER_FILE_RE.test(name)) statPart(path.join(this.answersDir, name))
      }
    } catch { /* no answers yet */ }
    return parts.join('|')
  }

  private reloadIfChanged(): void {
    if (this.signature() !== this.lastSignature) this.reload()
  }

  private reload(): void {
    if (this.disposed) return
    this.lastSignature = this.signature()
    this.loadState()
    this.answers = readAnswers(this.answersDir)

    const snap = this.snapshot()
    const payload = JSON.stringify([snap.state, snap.error])
    if (payload === this.lastPayload) return
    this.lastPayload = payload
    this.updatedAt = new Date().toISOString()
    const out = { ...snap, updatedAt: this.updatedAt }
    for (const fn of this.listeners) {
      try { fn(out) } catch { /* a broken listener must not stop the others */ }
    }
  }

  private loadState(): void {
    const file = path.join(this.dir, 'state.json')
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.raw = null
        this.error = null
      } else {
        this.error = `state.json cannot be read: ${(e as Error).message}`
      }
      return
    }
    if (!st.isFile()) { this.error = 'state.json is not a file'; return }
    if (st.size > MAX_STATE_BYTES) { this.error = `state.json is larger than ${MAX_STATE_BYTES} bytes`; return }
    let text: string
    try {
      text = readCapped(file, MAX_STATE_BYTES)
    } catch (e) {
      this.error = `state.json cannot be read: ${(e as Error).message}`
      return
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.error = 'state.json must contain a JSON object'
        return
      }
      this.raw = parsed as TeamState
      this.error = null
    } catch (e) {
      this.error = `state.json is not valid JSON: ${(e as Error).message}`
    }
  }

  private overlaid(): TeamState | null {
    return overlayAnswers(this.raw, this.answers)
  }
}

/** Read a file but never more than `cap` bytes (the file may grow after stat). */
function readCapped(file: string, cap: number): string {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(cap + 1)
    let total = 0
    for (;;) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null)
      if (n === 0) break
      total += n
      if (total > cap) throw new Error(`larger than ${cap} bytes`)
    }
    return buf.subarray(0, total).toString('utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

export function readAnswers(answersDir: string): Map<string, AnswerRecord> {
  const out = new Map<string, AnswerRecord>()
  let names: string[]
  try { names = fs.readdirSync(answersDir) } catch { return out }
  for (const name of names) {
    const m = ANSWER_FILE_RE.exec(name)
    if (!m) continue
    const rec = readAnswerFile(path.join(answersDir, name))
    if (rec) out.set(m[1], rec)
  }
  return out
}

export function readAnswerFile(file: string): AnswerRecord | null {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.size > MAX_ANSWER_FILE_BYTES) return null
    const parsed = JSON.parse(readCapped(file, MAX_ANSWER_FILE_BYTES)) as Partial<AnswerRecord>
    if (typeof parsed.answer !== 'string' || typeof parsed.answeredAt !== 'string') return null
    return { answer: parsed.answer, answeredAt: parsed.answeredAt }
  } catch {
    return null
  }
}

/** Copy of `state` with answer files applied to approvals that are not answered yet. */
export function overlayAnswers(state: TeamState | null, answers: Map<string, AnswerRecord>): TeamState | null {
  if (!state) return null
  const approvals = state.approvals
  if (answers.size === 0 || !approvals || typeof approvals !== 'object' || Array.isArray(approvals)) return state
  const nextApprovals: Record<string, unknown> = { ...(approvals as Record<string, unknown>) }
  let changed = false
  for (const [id, rec] of answers) {
    const a = nextApprovals[id]
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue
    if ((a as { status?: unknown }).status === 'answered') continue
    nextApprovals[id] = { ...(a as object), status: 'answered', answer: rec.answer, answeredAt: rec.answeredAt }
    changed = true
  }
  return changed ? { ...state, approvals: nextApprovals } : state
}
