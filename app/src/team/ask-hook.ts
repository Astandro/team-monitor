/**
 * Claude Code PreToolUse hook for AskUserQuestion: every question becomes an
 * open decision in the team monitor, so it can be answered from the phone.
 *
 * Input (stdin, Claude Code hook JSON): { hook_event_name, tool_name, tool_input: { questions: [
 *   { question, header, options: [{ label, description }], multiSelect } ] }, cwd, ... }
 *
 * Mode (`askHook` in <home>/config.json, default "redirect"):
 *   - mirror:   add the decisions, let the dialog run (exit 0, no output)
 *   - redirect: add the decisions and deny the dialog with a reason that tells
 *               the agent to wait for the answers with `wait-answer`
 *
 * Whatever goes wrong (no project, bad input, state.json unreadable) the hook
 * exits 0 with no output, so a dialog is never blocked by accident; the cause
 * goes to <home>/ask-hook.log (0600).
 */
import * as fs from 'fs'
import * as path from 'path'
import { ApprovalInput, addApprovals, validateApproval, MAX_TITLE_CHARS, MAX_OPTION_CHARS } from './ask'
import { buildRegistry, ensureHome, readConfigProjects, teamHome } from './config'

export type AskHookMode = 'mirror' | 'redirect'
export const DEFAULT_ASK_HOOK_MODE: AskHookMode = 'redirect'
export const MAX_HOOK_INPUT_BYTES = 1024 * 1024
const MAX_LOG_BYTES = 256 * 1024
const RECOMMENDED_RE = /\s*\(recommended\)\s*$/i

export interface HookQuestions { cwd: string; questions: ApprovalInput[] }

/**
 * Parse the hook JSON. Returns null when this is not an AskUserQuestion call
 * with at least one usable question; throws on malformed input.
 */
export function parseHookInput(text: string): HookQuestions | null {
  let data: Record<string, unknown>
  // JSON.parse messages quote the input; keep question text out of the log.
  try { data = JSON.parse(text) as Record<string, unknown> } catch { throw new Error('not valid JSON') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('hook input is not a JSON object')
  if (data.tool_name !== 'AskUserQuestion') return null
  if (typeof data.cwd !== 'string' || !path.isAbsolute(data.cwd)) throw new Error('hook input has no absolute cwd')
  const toolInput = data.tool_input as Record<string, unknown> | undefined
  const raw = toolInput && typeof toolInput === 'object' ? toolInput.questions : undefined
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('tool_input.questions is missing or empty')

  const questions = raw.map((q, i) => {
    if (!q || typeof q !== 'object') throw new Error(`question ${i + 1} is not an object`)
    const { question, header, options } = q as Record<string, unknown>
    if (typeof question !== 'string' || !question.trim()) throw new Error(`question ${i + 1} has no text`)
    let recommended: string | undefined
    const labels: string[] = []
    for (const o of Array.isArray(options) ? options : []) {
      const label = o && typeof o === 'object' ? (o as { label?: unknown }).label : o
      if (typeof label !== 'string' || !label.trim()) continue
      let clean = label.trim()
      if (RECOMMENDED_RE.test(clean)) {
        clean = clean.replace(RECOMMENDED_RE, '').trim()
        if (!clean) continue
        if (recommended === undefined) recommended = clean
      }
      labels.push(clean.slice(0, MAX_OPTION_CHARS))
    }
    const title = typeof header === 'string' && header.trim() ? header.trim() : question.trim()
    return validateApproval({
      title: title.slice(0, MAX_TITLE_CHARS),
      question: question.trim(),
      options: labels,
      recommended: recommended?.slice(0, MAX_OPTION_CHARS),
    })
  })
  return { cwd: data.cwd, questions }
}

function realDir(p: string): string | null {
  try {
    const r = fs.realpathSync(p)
    return fs.statSync(r).isDirectory() ? r : null
  } catch { return null }
}

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

/**
 * The project for `cwd`: the deepest registered project that contains it,
 * else the nearest folder at or above it that has `.agent-team/`.
 */
export function findProjectFor(cwd: string, home: string, warn: (m: string) => void = () => {}): string | null {
  const dir = realDir(cwd)
  if (!dir) return null
  const registered = buildRegistry(readConfigProjects(home, warn), [])
    .filter((p) => isInside(dir, p.path))
    .sort((a, b) => b.path.length - a.path.length)
  if (registered.length > 0) return registered[0].path
  for (let d = dir; ; d = path.dirname(d)) {
    try { if (fs.statSync(path.join(d, '.agent-team')).isDirectory()) return d } catch { /* keep going up */ }
    if (path.dirname(d) === d) return null
  }
}

/** `askHook` from <home>/config.json; anything missing or unknown means the default. */
export function readAskHookMode(home: string): AskHookMode {
  try {
    const file = path.join(home, 'config.json')
    if (fs.statSync(file).size > 1024 * 1024) return DEFAULT_ASK_HOOK_MODE
    const v = (JSON.parse(fs.readFileSync(file, 'utf-8')) as { askHook?: unknown }).askHook
    return v === 'mirror' || v === 'redirect' ? v : DEFAULT_ASK_HOOK_MODE
  } catch { return DEFAULT_ASK_HOOK_MODE }
}

export function denyResponse(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

export function redirectReason(project: string, ids: string[], questions: ApprovalInput[], waitCommand: string): string {
  const range = ids.length === 1 ? ids[0] : `${ids[0]}..${ids[ids.length - 1]}`
  const list = ids.map((id, i) => `${id} (${questions[i].title})`).join(', ')
  return [
    `Not shown as a dialog: the owner answers from the team monitor (phone). Your question${ids.length === 1 ? ' is' : 's are'} now`,
    `open decision${ids.length === 1 ? '' : 's'} ${range} in ${project}: ${list}.`,
    `Now: 1) run \`${waitCommand} --project "${project}"\` with run_in_background: true; it exits when an answer arrives`,
    `(run it again for the next answer); 2) also put the same question${ids.length === 1 ? '' : 's'} in chat, naming ${range},`,
    'so the owner can answer there too; 3) record each answer in state.json. Do not call AskUserQuestion again for these.',
  ].join(' ')
}

/** Append one line to <home>/ask-hook.log (0600), keeping one rotated copy. Never throws. */
export function logLine(home: string, msg: string, now: Date = new Date()): void {
  try {
    ensureHome(home)
    const file = path.join(home, 'ask-hook.log')
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.1')
    } catch { /* no log yet */ }
    fs.appendFileSync(file, `${now.toISOString()} ${msg.replace(/[\r\n]+/g, ' ')}\n`, { mode: 0o600 })
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600)
  } catch { /* logging must never break the hook */ }
}

export interface HookRunOptions {
  env?: NodeJS.ProcessEnv
  now?: () => Date
  /** Command the deny reason tells the agent to run (without --project). */
  waitCommand?: string
}

/** Run the hook on the raw stdin text. Always exit code 0; `stdout` is '' or one JSON object. */
export function runAskHook(stdinText: string, opts: HookRunOptions = {}): { code: 0; stdout: string } {
  const silent = { code: 0 as const, stdout: '' }
  let home: string
  try { home = teamHome(opts.env ?? process.env) } catch { return silent }
  const log = (m: string) => logLine(home, m, opts.now?.())
  try {
    if (Buffer.byteLength(stdinText) > MAX_HOOK_INPUT_BYTES) { log('skipped: hook input larger than 1 MB'); return silent }
    let parsed: HookQuestions | null
    try { parsed = parseHookInput(stdinText) } catch (e) {
      log(`skipped: bad hook input (${(e as Error).message})`)
      return silent
    }
    if (!parsed) return silent
    const project = findProjectFor(parsed.cwd, home, (m) => log(m))
    if (!project) { log(`skipped: no team project for cwd ${parsed.cwd}`); return silent }
    const mode = readAskHookMode(home)
    const ids = addApprovals(project, parsed.questions, { now: opts.now })
    log(`${mode}: added ${ids.join(', ')} to ${project}`)
    if (mode === 'mirror') return silent
    const waitCommand = opts.waitCommand ?? 'node <team-monitor>/app/dist/app.js wait-answer'
    return { code: 0, stdout: JSON.stringify(denyResponse(redirectReason(project, ids, parsed.questions, waitCommand))) + '\n' }
  } catch (e) {
    log(`skipped: ${(e as Error).message}`)
    return silent
  }
}
