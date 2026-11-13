/**
 * Coordinator wait command: block until a decision answer or a chat message arrives.
 *
 *   node app/dist/app.js wait-answer --project <path> [--timeout <s>] [--only-new] [--answers-only]
 *
 * Exits 0 and prints what woke it:
 * - an answer: the answer file name (`D3.json`) and its content, when a new or
 *   changed `<project>/.agent-team/answers/D<n>.json` appears;
 * - chat (unless `--answers-only`): for every unread message, `inbox/<file>`
 *   and the file's JSON, oldest first. A message is unread until state.json has
 *   `chat.<id>` with `from: "owner"`.
 * By default whatever is already on disk and not recorded yet (an answer to a
 * decision still `open`, an unread message) is reported at once, so nothing
 * that arrived between two waits is missed; answers come before messages.
 * Exits 124 on timeout, 2 on bad usage.
 *
 * Without `--answers-only` it also keeps the heartbeat `.agent-team/.watcher`
 * (heartbeat.ts), which the monitor uses to say whether Sora is listening.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { listInbox, MAX_INBOX_FILE_BYTES, readMessageIds } from './chat'
import { agentTeamDir, expandHome } from './config'
import { EndReason, startHeartbeat } from './heartbeat'
import { ANSWER_FILE_RE, MAX_ANSWER_FILE_BYTES, MAX_STATE_BYTES } from './state-watcher'

export interface WaitOptions {
  projectPath: string
  /** Give up after this many ms; undefined waits forever. */
  timeoutMs?: number
  pollMs?: number
  /** Report answers (and messages) already on disk and not recorded in state.json. Default true. */
  includePending?: boolean
  /** Only these decision ids (e.g. "D7") wake the wait; undefined means any decision. */
  ids?: ReadonlySet<string>
  /** Also wake on unread chat messages in `inbox/`. Default false (answers only, as `ask --wait`). */
  inbox?: boolean
}

export interface WaitItem { name: string; file: string; content: string }

/**
 * `name`/`file`/`content` are the first item. For an answer there is one item
 * (`name` = `D3.json`); for chat, one per unread message (`name` = `inbox/<file>`).
 */
export interface WaitResult extends WaitItem { kind: 'answer' | 'message'; items: WaitItem[] }

function listAnswers(answersDir: string, ids?: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>()
  let names: string[]
  try { names = fs.readdirSync(answersDir) } catch { return out }
  for (const name of names.sort()) {
    const m = ANSWER_FILE_RE.exec(name)
    if (!m) continue
    if (ids && !ids.has(m[1])) continue
    try {
      const file = path.join(answersDir, name)
      const st = fs.lstatSync(file)
      if (!st.isFile() || st.size > MAX_ANSWER_FILE_BYTES) continue
      out.set(name, fs.readFileSync(file, 'utf-8'))
    } catch { /* vanished between readdir and read */ }
  }
  return out
}

function readStateFile(teamDir: string): Record<string, unknown> | null {
  try {
    const file = path.join(teamDir, 'state.json')
    if (fs.statSync(file).size > MAX_STATE_BYTES) return null
    const s = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
    return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function openDecisionIds(state: Record<string, unknown> | null): Set<string> {
  const ids = new Set<string>()
  const approvals = state?.approvals
  if (!approvals || typeof approvals !== 'object') return ids
  for (const [id, a] of Object.entries(approvals as Record<string, { status?: unknown }>)) if (a && a.status === 'open') ids.add(id)
  return ids
}

/** Unread inbox messages (not in `chat` as owner entries), oldest first; `skip` = names to leave out. */
function unreadMessages(teamDir: string, inboxDir: string, skip?: ReadonlySet<string>): WaitItem[] {
  const read = readMessageIds(readStateFile(teamDir))
  const out: WaitItem[] = []
  for (const f of listInbox(inboxDir)) {
    if (read.has(f.id) || skip?.has(f.name)) continue
    const file = path.join(inboxDir, f.name)
    try {
      const st = fs.lstatSync(file)
      if (!st.isFile() || st.size > MAX_INBOX_FILE_BYTES) continue
      out.push({ name: `inbox/${f.name}`, file, content: fs.readFileSync(file, 'utf-8') })
    } catch { /* vanished */ }
  }
  return out
}

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

const answerResult = (answersDir: string, name: string, content: string): WaitResult => {
  const item = { name, file: path.join(answersDir, name), content }
  return { kind: 'answer', ...item, items: [item] }
}
const messageResult = (items: WaitItem[]): WaitResult => ({ kind: 'message', ...items[0], items })

export function waitForAnswer(opts: WaitOptions): Promise<WaitResult | null> {
  const teamDir = agentTeamDir(opts.projectPath)
  const answersDir = path.join(teamDir, 'answers')
  const inboxDir = path.join(teamDir, 'inbox')
  const pollMs = opts.pollMs ?? 500
  const inbox = opts.inbox === true

  const baseline = new Map<string, string>()
  const initial = listAnswers(answersDir, opts.ids)
  for (const [name, content] of initial) baseline.set(name, hash(content))
  // Inbox files never change after they appear; with --only-new the ones already there are ignored.
  const inboxBaseline = new Set<string>()
  if (inbox && opts.includePending === false) for (const f of listInbox(inboxDir)) inboxBaseline.add(f.name)

  if (opts.includePending !== false) {
    const open = openDecisionIds(readStateFile(teamDir))
    for (const [name, content] of initial) {
      const id = ANSWER_FILE_RE.exec(name)![1]
      if (open.has(id)) return Promise.resolve(answerResult(answersDir, name, content))
    }
    if (inbox) {
      const pending = unreadMessages(teamDir, inboxDir)
      if (pending.length) return Promise.resolve(messageResult(pending))
    }
  }

  return new Promise((resolve) => {
    const watchers: fs.FSWatcher[] = []
    const watched = new Set<string>()
    let finished = false
    let poll: NodeJS.Timeout | null = null
    let timer: NodeJS.Timeout | null = null

    const finish = (r: WaitResult | null) => {
      if (finished) return
      finished = true
      for (const w of watchers) { try { w.close() } catch { /* closed */ } }
      if (poll) clearInterval(poll)
      if (timer) clearTimeout(timer)
      resolve(r)
    }

    const check = () => {
      if (finished) return
      for (const [name, content] of listAnswers(answersDir, opts.ids)) {
        if (baseline.get(name) !== hash(content)) {
          finish(answerResult(answersDir, name, content))
          return
        }
      }
      if (inbox) {
        const fresh = unreadMessages(teamDir, inboxDir, inboxBaseline)
        if (fresh.length) finish(messageResult(fresh))
      }
    }

    const dirs = inbox ? [teamDir, answersDir, inboxDir] : [teamDir, answersDir]
    const attach = () => {
      for (const dir of dirs) {
        if (watched.has(dir)) continue
        try {
          const w = fs.watch(dir, () => check())
          w.on('error', () => { watched.delete(dir); try { w.close() } catch { /* closed */ } })
          watchers.push(w)
          watched.add(dir)
        } catch { /* folder does not exist yet; the poll retries */ }
      }
    }

    attach()
    poll = setInterval(() => { attach(); check() }, pollMs)
    if (opts.timeoutMs !== undefined) timer = setTimeout(() => finish(null), opts.timeoutMs)
    check()
  })
}

/** Text printed for a result: `<name>\n<content>\n` per item. */
export function formatWaitResult(r: WaitResult): string {
  return r.items.map((i) => `${i.name}\n${i.content.trim()}\n`).join('')
}

export const WAIT_TIMEOUT_EXIT = 124

const USAGE = `Usage: wait-answer [--project <path>] [--timeout <seconds>] [--only-new] [--answers-only]

Waits until a decision answer appears in <project>/.agent-team/answers/ or (unless
--answers-only) an unread chat message appears in <project>/.agent-team/inbox/,
and prints the file name(s) and JSON content. Exit codes: 0 answer or message,
124 timeout, 2 bad usage.`

const SIGNALS: Array<[NodeJS.Signals, number]> = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]

export async function runWaitAnswerCli(
  argv: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
  err: (s: string) => void = (s) => process.stderr.write(s),
): Promise<number> {
  let project = process.cwd()
  let timeoutMs: number | undefined
  let includePending = true
  let inbox = true
  let pollMs: number | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--project' && next) { project = path.resolve(expandHome(next)); i++ }
    else if (a === '--timeout' && next) {
      const s = Number(next)
      if (!Number.isFinite(s) || s <= 0) { err(`--timeout must be a positive number of seconds\n${USAGE}\n`); return 2 }
      timeoutMs = Math.round(s * 1000); i++
    }
    else if (a === '--poll-ms' && next) { pollMs = Math.max(50, Number(next) || 500); i++ }
    else if (a === '--only-new') includePending = false
    else if (a === '--answers-only') inbox = false
    else if (a === '--help' || a === '-h') { out(USAGE + '\n'); return 0 }
    else { err(`Unknown argument: ${a}\n${USAGE}\n`); return 2 }
  }

  try {
    if (!fs.statSync(project).isDirectory()) throw new Error('not a directory')
  } catch {
    err(`Project folder not found: ${project}\n`)
    return 2
  }

  // Heartbeat only for the chat watcher; answer-only waits (and `ask --wait`) leave it alone.
  const teamDir = agentTeamDir(project)
  // Writes fail silently until `.agent-team/` exists; the next beat retries.
  const heartbeat = inbox ? startHeartbeat(teamDir) : null
  const onSignal: Array<[NodeJS.Signals, () => void]> = []
  if (heartbeat) {
    for (const [sig, code] of SIGNALS) {
      const fn = () => { heartbeat.stop('signal'); process.exit(code) }
      process.once(sig, fn)
      onSignal.push([sig, fn])
    }
  }
  const end = (reason: EndReason) => {
    for (const [sig, fn] of onSignal) process.removeListener(sig, fn)
    heartbeat?.stop(reason)
  }

  let r: WaitResult | null
  try {
    r = await waitForAnswer({ projectPath: project, timeoutMs, includePending, pollMs, inbox })
  } catch (e) {
    end('error')
    throw e
  }
  if (!r) {
    end('timeout')
    err(`No answer or message within ${timeoutMs! / 1000}s\n`)
    return WAIT_TIMEOUT_EXIT
  }
  end(r.kind)
  out(formatWaitResult(r))
  return 0
}
