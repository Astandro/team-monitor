/**
 * Coordinator ask command: add an open decision to state.json in one step.
 *
 *   node app/dist/app.js ask --project <path> --title <t> --question <q> --option <o>... \
 *     [--recommended <o>] [--wait] [--timeout <s>]
 *   node app/dist/app.js ask --project <path> --json <file> [--wait] [--timeout <s>]
 *
 * Adds the next free `D<n>` to `approvals` (status open, askedAt now, order n)
 * and prints the id. With --wait it then waits for the answer to that id only,
 * like `wait-answer` (exit 0 with the answer, 124 on timeout). Exit 2 on bad
 * usage, 1 when state.json cannot be updated.
 *
 * The coordinator owns state.json (A2). This command runs on the coordinator's
 * side: it re-reads the file right before the rename and starts over if the
 * file changed since it was read, so a concurrent edit is kept, and it writes
 * through a temp file in the same folder (fsync, rename).
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { agentTeamDir, expandHome } from './config'
import { DECISION_ID_RE } from './answers'
import { MAX_STATE_BYTES } from './state-watcher'
import { WAIT_TIMEOUT_EXIT, waitForAnswer } from './wait-answer'

export const MAX_TITLE_CHARS = 200
export const MAX_QUESTION_CHARS = 4000
export const MAX_OPTIONS = 20
export const MAX_OPTION_CHARS = 500
const MAX_DECISION_NUMBER = 9999

export interface ApprovalInput {
  title: string
  question: string
  options: string[]
  recommended?: string
}

export class AskError extends Error {}

/** Validate and normalise one approval (trimmed strings, caps, recommended must be an option). Throws AskError. */
export function validateApproval(raw: unknown): ApprovalInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AskError('approval must be a JSON object')
  const r = raw as Record<string, unknown>
  const str = (v: unknown, name: string, max: number): string => {
    if (typeof v !== 'string' || !v.trim()) throw new AskError(`${name} is required`)
    const s = v.trim()
    if (s.length > max) throw new AskError(`${name} is longer than ${max} characters`)
    return s
  }
  const title = str(r.title, 'title', MAX_TITLE_CHARS)
  const question = str(r.question, 'question', MAX_QUESTION_CHARS)
  const rawOptions = r.options === undefined ? [] : r.options
  if (!Array.isArray(rawOptions)) throw new AskError('options must be an array of strings')
  if (rawOptions.length > MAX_OPTIONS) throw new AskError(`at most ${MAX_OPTIONS} options`)
  const options = rawOptions.map((o, i) => str(o, `option ${i + 1}`, MAX_OPTION_CHARS))
  const out: ApprovalInput = { title, question, options }
  if (r.recommended !== undefined && r.recommended !== null && r.recommended !== '') {
    const rec = str(r.recommended, 'recommended', MAX_OPTION_CHARS)
    if (options.length > 0 && !options.includes(rec)) throw new AskError('recommended must be one of the options')
    out.recommended = rec
  }
  return out
}

/**
 * The next `count` free decision ids: above every `D<n>` already in `approvals`
 * (gaps are not reused, so an old answer file can never answer a new
 * question) and skipping any id that already has an answer file.
 */
export function nextDecisionIds(approvals: Record<string, unknown>, answersDir: string | null, count: number): string[] {
  let max = 0
  for (const key of Object.keys(approvals)) {
    if (!DECISION_ID_RE.test(key)) continue
    max = Math.max(max, Number(key.slice(1)))
  }
  const ids: string[] = []
  for (let n = max + 1; ids.length < count; n++) {
    if (n > MAX_DECISION_NUMBER) throw new AskError(`no free decision id left (D${MAX_DECISION_NUMBER} reached)`)
    const id = `D${n}`
    if (answersDir && fs.existsSync(path.join(answersDir, `${id}.json`))) continue
    ids.push(id)
  }
  return ids
}

function readStateText(file: string): string | null {
  let st: fs.Stats
  try { st = fs.statSync(file) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  if (st.size > MAX_STATE_BYTES) throw new AskError(`state.json is larger than ${MAX_STATE_BYTES} bytes`)
  return fs.readFileSync(file, 'utf-8')
}

function parseState(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === '') return {}
  let parsed: unknown
  // No parser detail: it quotes the file, and this message also lands in the hook log.
  try { parsed = JSON.parse(text) } catch { throw new AskError('state.json is not valid JSON; fix it first') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AskError('state.json must hold a JSON object')
  return parsed as Record<string, unknown>
}

export interface AddOptions {
  now?: () => Date
  /** Test seam: runs after the temp file is written and before the re-read and rename. */
  beforeCommit?: (attempt: number) => void
  maxAttempts?: number
}

/**
 * Add one open approval per input to `<project>/.agent-team/state.json` and
 * return the new ids, in input order. Throws AskError (or an fs error).
 */
export function addApprovals(projectPath: string, inputs: ApprovalInput[], opts: AddOptions = {}): string[] {
  if (inputs.length === 0) throw new AskError('nothing to ask')
  const now = opts.now ?? (() => new Date())
  const dir = agentTeamDir(projectPath)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'state.json')
  const answersDir = path.join(dir, 'answers')
  const attempts = opts.maxAttempts ?? 5

  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = readStateText(file)
    const state = parseState(before)
    const approvals = state.approvals === undefined ? {} : state.approvals
    if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) throw new AskError('state.json "approvals" must be an object')
    const ids = nextDecisionIds(approvals as Record<string, unknown>, answersDir, inputs.length)
    const askedAt = now().toISOString()
    const next: Record<string, unknown> = { ...(approvals as Record<string, unknown>) }
    ids.forEach((id, i) => {
      const a = inputs[i]
      next[id] = {
        title: a.title,
        question: a.question,
        options: a.options,
        ...(a.recommended ? { recommended: a.recommended } : {}),
        status: 'open',
        askedAt,
        order: Number(id.slice(1)),
      }
    })
    const body = JSON.stringify({ ...state, approvals: next }, null, 2) + '\n'

    let mode = 0o644
    try { mode = fs.statSync(file).mode & 0o777 } catch { /* new file */ }
    const tmp = path.join(dir, `.state.json.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`)
    let renamed = false
    try {
      const fd = fs.openSync(tmp, 'wx', mode)
      try {
        fs.writeSync(fd, body)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      opts.beforeCommit?.(attempt)
      // Someone else wrote state.json since we read it: start over on the new content.
      if (readStateText(file) !== before) continue
      fs.renameSync(tmp, file)
      renamed = true
    } finally {
      if (!renamed) { try { fs.unlinkSync(tmp) } catch { /* already gone */ } }
    }
    try {
      const dfd = fs.openSync(dir, 'r')
      try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
    } catch { /* directory fsync is best effort */ }
    return ids
  }
  throw new AskError(`state.json kept changing; gave up after ${attempts} attempts`)
}

const USAGE = `Usage: ask --project <path> --title <t> --question <q> [--option <o>]... [--recommended <o>]
           [--wait] [--timeout <seconds>]
       ask --project <path> --json <file> [--wait] [--timeout <seconds>]

Adds the next free decision D<n> (status open) to <project>/.agent-team/state.json
and prints its id. --json reads {"title","question","options","recommended"} from
a file. With --wait, then waits for the answer to that decision only and prints
the answer file name and content. Exit codes: 0 ok/answer, 124 timeout,
2 bad usage, 1 state.json could not be updated.`

export async function runAskCli(
  argv: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
  err: (s: string) => void = (s) => process.stderr.write(s),
): Promise<number> {
  let project = process.cwd()
  let title: string | undefined
  let question: string | undefined
  const options: string[] = []
  let recommended: string | undefined
  let jsonFile: string | undefined
  let wait = false
  let timeoutMs: number | undefined
  let pollMs: number | undefined

  const bad = (msg: string) => { err(`${msg}\n${USAGE}\n`); return 2 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    const hasNext = next !== undefined
    if (a === '--project' && hasNext) { project = path.resolve(expandHome(next)); i++ }
    else if (a === '--title' && hasNext) { title = next; i++ }
    else if (a === '--question' && hasNext) { question = next; i++ }
    else if (a === '--option' && hasNext) { options.push(next); i++ }
    else if (a === '--recommended' && hasNext) { recommended = next; i++ }
    else if (a === '--json' && hasNext) { jsonFile = path.resolve(expandHome(next)); i++ }
    else if (a === '--wait') wait = true
    else if (a === '--timeout' && hasNext) {
      const s = Number(next)
      if (!Number.isFinite(s) || s <= 0) return bad('--timeout must be a positive number of seconds')
      timeoutMs = Math.round(s * 1000); i++
    }
    else if (a === '--poll-ms' && hasNext) { pollMs = Math.max(50, Number(next) || 500); i++ }
    else if (a === '--help' || a === '-h') { out(USAGE + '\n'); return 0 }
    else return bad(`Unknown or incomplete argument: ${a}`)
  }
  if (timeoutMs !== undefined && !wait) return bad('--timeout needs --wait')

  try {
    if (!fs.statSync(project).isDirectory()) throw new Error('not a directory')
  } catch {
    err(`Project folder not found: ${project}\n`)
    return 2
  }

  let input: ApprovalInput
  try {
    if (jsonFile !== undefined) {
      if (title !== undefined || question !== undefined || options.length > 0 || recommended !== undefined) {
        return bad('--json cannot be combined with --title, --question, --option or --recommended')
      }
      let text: string
      try {
        if (fs.statSync(jsonFile).size > 64 * 1024) throw new AskError('--json file is larger than 64 KB')
        text = fs.readFileSync(jsonFile, 'utf-8')
      } catch (e) {
        if (e instanceof AskError) throw e
        throw new AskError(`cannot read --json file: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`)
      }
      let raw: unknown
      try { raw = JSON.parse(text) } catch { throw new AskError('--json file is not valid JSON') }
      input = validateApproval(raw)
    } else {
      input = validateApproval({ title, question, options, recommended })
    }
  } catch (e) {
    if (e instanceof AskError) return bad(e.message)
    throw e
  }

  let id: string
  try {
    [id] = addApprovals(project, [input])
  } catch (e) {
    err(`Cannot add the decision: ${(e as Error).message}\n`)
    return 1
  }
  out(`${id}\n`)
  if (!wait) return 0

  const r = await waitForAnswer({ projectPath: project, timeoutMs, pollMs, ids: new Set([id]) })
  if (!r) {
    err(`No answer to ${id} within ${timeoutMs! / 1000}s\n`)
    return WAIT_TIMEOUT_EXIT
  }
  out(`${r.name}\n${r.content.trim()}\n`)
  return 0
}
