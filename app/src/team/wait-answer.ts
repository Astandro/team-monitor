/**
 * Coordinator wait command: block until a decision answer arrives.
 *
 *   node app/dist/app.js wait-answer --project <path> [--timeout <s>] [--only-new]
 *
 * Exits 0 and prints the answer file name and its content when a new or
 * changed `<project>/.agent-team/answers/D<n>.json` appears. By default an
 * answer that is already on disk for a decision still `open` in state.json
 * (an answer the coordinator has not recorded yet) is reported at once, so an
 * answer given between two waits is never missed. Exits 124 on timeout,
 * 2 on bad usage.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { agentTeamDir, expandHome } from './config'
import { ANSWER_FILE_RE, MAX_ANSWER_FILE_BYTES, MAX_STATE_BYTES } from './state-watcher'

export interface WaitOptions {
  projectPath: string
  /** Give up after this many ms; undefined waits forever. */
  timeoutMs?: number
  pollMs?: number
  /** Report answers already on disk for decisions still open in state.json. Default true. */
  includePending?: boolean
}

export interface WaitResult { name: string; file: string; content: string }

function listAnswers(answersDir: string): Map<string, string> {
  const out = new Map<string, string>()
  let names: string[]
  try { names = fs.readdirSync(answersDir) } catch { return out }
  for (const name of names.sort()) {
    if (!ANSWER_FILE_RE.test(name)) continue
    try {
      const file = path.join(answersDir, name)
      const st = fs.lstatSync(file)
      if (!st.isFile() || st.size > MAX_ANSWER_FILE_BYTES) continue
      out.set(name, fs.readFileSync(file, 'utf-8'))
    } catch { /* vanished between readdir and read */ }
  }
  return out
}

function openDecisionIds(teamDir: string): Set<string> {
  const ids = new Set<string>()
  try {
    const file = path.join(teamDir, 'state.json')
    if (fs.statSync(file).size > MAX_STATE_BYTES) return ids
    const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as { approvals?: Record<string, { status?: unknown }> }
    for (const [id, a] of Object.entries(state.approvals ?? {})) if (a && a.status === 'open') ids.add(id)
  } catch { /* no state yet */ }
  return ids
}

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

export function waitForAnswer(opts: WaitOptions): Promise<WaitResult | null> {
  const teamDir = agentTeamDir(opts.projectPath)
  const answersDir = path.join(teamDir, 'answers')
  const pollMs = opts.pollMs ?? 500

  const baseline = new Map<string, string>()
  const initial = listAnswers(answersDir)
  for (const [name, content] of initial) baseline.set(name, hash(content))

  if (opts.includePending !== false) {
    const open = openDecisionIds(teamDir)
    for (const [name, content] of initial) {
      const id = ANSWER_FILE_RE.exec(name)![1]
      if (open.has(id)) return Promise.resolve({ name, file: path.join(answersDir, name), content })
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
      for (const [name, content] of listAnswers(answersDir)) {
        if (baseline.get(name) !== hash(content)) {
          finish({ name, file: path.join(answersDir, name), content })
          return
        }
      }
    }

    const attach = () => {
      for (const dir of [teamDir, answersDir]) {
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

export const WAIT_TIMEOUT_EXIT = 124

const USAGE = `Usage: wait-answer [--project <path>] [--timeout <seconds>] [--only-new]

Waits until a decision answer appears in <project>/.agent-team/answers/ and
prints the file name and its JSON content. Exit codes: 0 answer, 124 timeout,
2 bad usage.`

export async function runWaitAnswerCli(
  argv: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
  err: (s: string) => void = (s) => process.stderr.write(s),
): Promise<number> {
  let project = process.cwd()
  let timeoutMs: number | undefined
  let includePending = true
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
    else if (a === '--help' || a === '-h') { out(USAGE + '\n'); return 0 }
    else { err(`Unknown argument: ${a}\n${USAGE}\n`); return 2 }
  }

  try {
    if (!fs.statSync(project).isDirectory()) throw new Error('not a directory')
  } catch {
    err(`Project folder not found: ${project}\n`)
    return 2
  }

  const r = await waitForAnswer({ projectPath: project, timeoutMs, includePending, pollMs })
  if (!r) {
    err(`No answer within ${timeoutMs! / 1000}s\n`)
    return WAIT_TIMEOUT_EXIT
  }
  out(`${r.name}\n${r.content.trim()}\n`)
  return 0
}
