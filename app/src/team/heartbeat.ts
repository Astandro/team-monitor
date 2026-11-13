/**
 * "Is Sora listening?" signal for the chat panel.
 *
 * The coordinator's background watcher (`wait-answer` without `--answers-only`)
 * keeps `<project>/.agent-team/.watcher` up to date:
 *
 *   {"pid": 123, "startedAt": "ISO", "beatAt": "ISO"}                       while it waits
 *   {"pid": 123, "startedAt": "ISO", "beatAt": "ISO", "endedAt": "ISO",
 *    "reason": "message" | "answer" | "timeout" | "signal" | "error"}       after it ended
 *
 * The record is rewritten (temp file + rename) every `HEARTBEAT_INTERVAL_MS`,
 * and on exit only while it still carries this process's pid, so a second
 * watcher running at the same time is never marked as ended by the first.
 *
 * The server serves `watcher: {alive, since}`:
 * - alive while a watcher waits: no `endedAt`, the pid is running and `beatAt`
 *   is younger than `HEARTBEAT_STALE_MS`;
 * - alive for `HANDLING_GRACE_MS` after a watcher ended because it delivered a
 *   message, an answer or a timeout (that exit is what wakes the coordinator,
 *   who is then handling it and starts the next watcher);
 * - not alive otherwise (never ran, stopped by a signal, killed, stale).
 * `since`: when alive, the start of the latest watcher; when not alive, the last
 * sign of life (`endedAt`, else `beatAt`), or null if no watcher ever ran.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export const HEARTBEAT_FILE = '.watcher'
export const HEARTBEAT_INTERVAL_MS = 10_000
export const HEARTBEAT_STALE_MS = 30_000
export const HANDLING_GRACE_MS = 5 * 60_000
const MAX_HEARTBEAT_BYTES = 4096

export type EndReason = 'message' | 'answer' | 'timeout' | 'signal' | 'error'

export interface HeartbeatRecord {
  pid: number
  startedAt: string
  beatAt: string
  endedAt?: string
  reason?: EndReason
}

export interface WatcherStatus { alive: boolean; since: string | null }

export function heartbeatPath(teamDir: string): string {
  return path.join(teamDir, HEARTBEAT_FILE)
}

export function readHeartbeat(teamDir: string): HeartbeatRecord | null {
  const file = heartbeatPath(teamDir)
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.size > MAX_HEARTBEAT_BYTES) return null
    const r = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<HeartbeatRecord>
    if (!Number.isInteger(r.pid) || (r.pid as number) <= 0) return null
    if (typeof r.startedAt !== 'string' || typeof r.beatAt !== 'string') return null
    const out: HeartbeatRecord = { pid: r.pid as number, startedAt: r.startedAt, beatAt: r.beatAt }
    if (typeof r.endedAt === 'string') out.endedAt = r.endedAt
    if (typeof r.reason === 'string') out.reason = r.reason as EndReason
    return out
  } catch {
    return null
  }
}

export function writeHeartbeat(teamDir: string, rec: HeartbeatRecord): void {
  const file = heartbeatPath(teamDir)
  const tmp = path.join(teamDir, `${HEARTBEAT_FILE}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(rec) + '\n', { flag: 'wx', mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* not there */ }
    // A missing .agent-team folder or a full disk must not stop the wait itself.
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface StatusOptions {
  now?: () => number
  pidAlive?: (pid: number) => boolean
  staleMs?: number
  graceMs?: number
}

export function watcherStatus(rec: HeartbeatRecord | null, opts: StatusOptions = {}): WatcherStatus {
  if (!rec) return { alive: false, since: null }
  const now = (opts.now ?? Date.now)()
  const pidAlive = opts.pidAlive ?? isPidAlive
  const staleMs = opts.staleMs ?? HEARTBEAT_STALE_MS
  const graceMs = opts.graceMs ?? HANDLING_GRACE_MS
  if (rec.endedAt !== undefined) {
    const ended = Date.parse(rec.endedAt)
    const handling = rec.reason !== 'signal' && rec.reason !== 'error' && Number.isFinite(ended) && now - ended < graceMs
    return handling ? { alive: true, since: rec.startedAt } : { alive: false, since: rec.endedAt }
  }
  const beat = Date.parse(rec.beatAt)
  if (Number.isFinite(beat) && now - beat < staleMs && pidAlive(rec.pid)) return { alive: true, since: rec.startedAt }
  return { alive: false, since: rec.beatAt }
}

export function readWatcherStatus(teamDir: string, opts: StatusOptions = {}): WatcherStatus {
  return watcherStatus(readHeartbeat(teamDir), opts)
}

export interface Heartbeat {
  /** Record why the watcher ended. Idempotent; stops the timer. */
  stop(reason: EndReason): void
}

export function startHeartbeat(
  teamDir: string,
  opts: { intervalMs?: number; now?: () => Date; pid?: number } = {},
): Heartbeat {
  const now = opts.now ?? (() => new Date())
  const pid = opts.pid ?? process.pid
  const startedAt = now().toISOString()
  const beat = () => writeHeartbeat(teamDir, { pid, startedAt, beatAt: now().toISOString() })
  beat()
  const timer = setInterval(beat, opts.intervalMs ?? HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  let stopped = false
  return {
    stop(reason) {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      // Only end our own record: another watcher may have taken the file over.
      const cur = readHeartbeat(teamDir)
      if (cur && cur.pid !== pid) return
      const t = now().toISOString()
      writeHeartbeat(teamDir, { pid, startedAt, beatAt: t, endedAt: t, reason })
    },
  }
}
