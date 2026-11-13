/**
 * Readable shell commands for tool-call cards, the timeline and particle labels (owner screenshot 13 Nov).
 *
 * Agents usually run `cd /Users/<someone>/projects/<repo> && npm test`, so a card cut at the end read
 * "Jalanin perintah: cd /Users/a…" and hid the part that matters. Here:
 * - leading setup steps are dropped (`cd <dir> &&`, `cd <dir>;`, `pushd`, `export X=…`, `X=…`, `set -e`,
 *   `source …`) and so are inline `X=… ` prefixes and `env`, so the label starts with the actual action;
 * - `bash -lc "…"` / `sh -c '…'` / `zsh -c …` wrappers are opened;
 * - heredoc bodies are left out and whitespace is collapsed to one line;
 * - the last `cd` directory is kept as a short name (its last path part) for a muted suffix;
 * - when the text is still too long it is shortened in the middle (start and end kept, `…` between).
 * The full command stays one tap away in the tool detail popup (inputData.command).
 * Pure: no canvas, no DOM.
 */

export interface ReadableCommand {
  /** What the command does, one line, setup removed */
  action: string
  /** Short name of the directory the setup moved into, or null */
  dir: string | null
}

/** Tools whose argument is a shell command (Claude Code and Codex). */
const COMMAND_TOOLS = new Set(['Bash', 'exec_command'])

export function isCommandTool(toolName: string | undefined | null): boolean {
  return COMMAND_TOOLS.has((toolName ?? '').trim())
}

interface Segment {
  /** Offsets into the command string, separator excluded */
  start: number
  end: number
}

/**
 * Splits a command at top-level `&&`, `||`, `;` and newlines (pipes and a lone `&` stay inside a segment). Quotes,
 * `$(…)`, `(…)`, backticks and heredoc bodies are never split. Returns the segments and the heredoc body ranges.
 */
function splitTopLevel(cmd: string): { segments: Segment[]; bodies: Array<[number, number]> } {
  const segments: Segment[] = []
  const bodies: Array<[number, number]> = []
  const heredocs: string[] = []
  let start = 0
  let depth = 0
  let quote: '"' | "'" | '`' | null = null
  let i = 0
  const push = (end: number) => { segments.push({ start, end }) }
  while (i < cmd.length) {
    const c = cmd[i]
    if (quote) {
      if (c === '\\' && quote !== "'") { i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '\\') { i += 2; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue }
    if (c === '(') { depth++; i++; continue }
    if (c === ')') { depth = Math.max(0, depth - 1); i++; continue }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(cmd.slice(i))
      if (m) { heredocs.push(m[2]); i += m[0].length; continue }
    }
    if (c === '\n') {
      if (heredocs.length) {
        // skip the heredoc bodies: the lines up to each terminator belong to this command
        let pos = i + 1
        const bodyStart = i
        while (heredocs.length && pos <= cmd.length) {
          const nl = cmd.indexOf('\n', pos)
          const lineEnd = nl === -1 ? cmd.length : nl
          if (cmd.slice(pos, lineEnd).trim() === heredocs[0]) heredocs.shift()
          pos = lineEnd + 1
          if (nl === -1) break
        }
        heredocs.length = 0
        bodies.push([bodyStart, Math.min(pos, cmd.length)])
        i = pos
        // the command that owns the heredoc ends with its body
        if (depth === 0) { push(Math.min(pos, cmd.length)); start = Math.min(pos, cmd.length) }
        continue
      }
      if (depth === 0) { push(i); start = i + 1 }
      i++
      continue
    }
    if (depth === 0) {
      const two = cmd.slice(i, i + 2)
      if (two === '&&' || two === '||') { push(i); i += 2; start = i; continue }
      if (c === ';' && cmd[i + 1] !== ';') { push(i); i++; start = i; continue }
    }
    i++
  }
  push(cmd.length)
  return { segments: segments.filter((s) => cmd.slice(s.start, s.end).trim() !== ''), bodies }
}

const ASSIGN = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|\$\([^)]*\)|[^\s;&|]*)`
const PURE_ASSIGNMENTS = new RegExp(String.raw`^(?:${ASSIGN})(?:\s+${ASSIGN})*$`)
const LEADING_ASSIGNMENT = new RegExp(String.raw`^(?:env\s+)?(?:${ASSIGN}\s+)+`)

function unquote(word: string): string {
  const w = word.trim()
  if (w.length >= 2 && (w[0] === '"' || w[0] === "'") && w[w.length - 1] === w[0]) return w.slice(1, -1)
  return w
}

/** "/Users/a/projects/my-app/" -> "my-app"; "~" and "/" stay as they are. */
export function shortDir(dir: string): string {
  const d = unquote(dir).replace(/\/+$/, '')
  if (d === '' ) return dir.trim() === '/' ? '/' : ''
  const parts = d.split('/')
  return parts[parts.length - 1] || d
}

/** The directory a `cd`/`pushd` segment moves into, undefined when the segment is not one. */
function cdTarget(seg: string): string | undefined {
  const m = /^(?:cd|pushd)(?:\s+(?:-[LPe@]+\s+)*(.+))?$/.exec(seg)
  if (!m) return undefined
  const target = (m[1] ?? '').trim()
  return target === '' ? '~' : target
}

function isSetup(seg: string): boolean {
  return cdTarget(seg) !== undefined
    || /^export(?:\s|$)/.test(seg)
    || /^unset\s/.test(seg)
    || /^set\s+[-+][A-Za-z]/.test(seg)
    || /^(?:source|\.)\s+\S/.test(seg)
    || PURE_ASSIGNMENTS.test(seg)
}

const SHELL_WRAPPER = /^(?:\S*\/)?(?:bash|sh|zsh|dash)\s+(?:-[A-Za-z]+\s+)*?-[A-Za-z]*c[A-Za-z]*\s+(['"])([\s\S]*)\1\s*$/

/** The inner command of `bash -lc "…"` and friends, or null. */
function unwrapShell(cmd: string): string | null {
  const m = SHELL_WRAPPER.exec(cmd.trim())
  if (!m) return null
  const inner = m[2]
  if (m[1] === "'") {
    // a single-quoted script cannot hold a bare single quote, so a match that does is not one script
    return inner.includes("'") && !inner.includes(`'\\''`) ? null : inner.replace(/'\\''/g, "'")
  }
  return inner.replace(/\\(["\\$`])/g, '$1')
}

function oneLine(text: string, bodies: Array<[number, number]>, from: number, to: number): string {
  let out = ''
  let pos = from
  for (const [a, b] of bodies) {
    if (b <= from || a >= to) continue
    out += text.slice(pos, Math.max(pos, a)) + ' '
    pos = Math.max(pos, b)
  }
  out += text.slice(pos, to)
  return out.replace(/\s+/g, ' ').trim()
}

/** The readable action of a shell command plus the short directory it ran in. */
export function readableCommand(command: string | undefined | null, depth = 0): ReadableCommand {
  const cmd = (command ?? '').trim()
  if (!cmd) return { action: '', dir: null }
  const { segments, bodies } = splitTopLevel(cmd)
  let dir: string | null = null
  let first = 0
  for (; first < segments.length; first++) {
    const seg = oneLine(cmd, bodies, segments[first].start, segments[first].end)
    if (!isSetup(seg)) break
    const target = cdTarget(seg)
    if (target !== undefined) dir = shortDir(target)
  }
  // nothing but setup (a bare `cd x`): that is the action itself
  if (first >= segments.length) return { action: oneLine(cmd, bodies, 0, cmd.length), dir: null }

  let action = oneLine(cmd, bodies, segments[first].start, cmd.length)
  const stripped = action.replace(LEADING_ASSIGNMENT, '')
  if (stripped.trim()) action = stripped.trim()

  const inner = depth < 3 ? unwrapShell(cmd.slice(segments[first].start).trim().replace(LEADING_ASSIGNMENT, '')) : null
  if (inner !== null && segments.length - first === 1) {
    const sub = readableCommand(inner, depth + 1)
    if (sub.action) return { action: sub.action, dir: sub.dir ?? dir }
  }
  return { action, dir }
}

/** The full command behind a tool call (inputData.command), falling back to the summarised args. */
export function commandText(args?: string, inputData?: Record<string, unknown>): string {
  const full = inputData?.command ?? inputData?.cmd
  if (typeof full === 'string' && full.trim()) return full
  return args ?? ''
}

/** What a card shows after the tool label: the readable action for shell commands, the args otherwise. */
export function toolArgsDisplay(toolName: string, args?: string, inputData?: Record<string, unknown>): ReadableCommand {
  if (!isCommandTool(toolName)) return { action: (args ?? '').replace(/\s+/g, ' ').trim(), dir: null }
  return readableCommand(commandText(args, inputData))
}

/** Share of the kept characters that go to the start when shortening in the middle. */
export const MIDDLE_HEAD_SHARE = 0.6

/**
 * Shortens `text` in the middle until `measure` fits `maxWidth`: the start and the end stay, `…` goes between.
 * Returns the text unchanged when it fits, `…` when not even one character fits.
 */
export function middleTruncate(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (measure(text) <= maxWidth) return text
  const cut = (n: number) => {
    const head = Math.ceil(n * MIDDLE_HEAD_SHARE)
    const tail = n - head
    return text.slice(0, head).trimEnd() + '\u2026' + (tail > 0 ? text.slice(text.length - tail).trimStart() : '')
  }
  let lo = 0
  let hi = text.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (measure(cut(mid)) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? cut(lo) : '\u2026'
}

/** Middle shortening by character count (timeline and particle labels). */
export function middleCut(text: string, maxChars: number): string {
  return middleTruncate(text, maxChars, (s) => s.length)
}

/**
 * `<label>: <action>` that fits `maxWidth`: the label stays whole and only the action is shortened in the middle.
 * If not even the label and a few characters fit, the whole line is shortened in the middle.
 */
export function fitLabelLine(label: string, action: string, maxWidth: number, measure: (s: string) => number): string {
  if (!action) return middleTruncate(label, maxWidth, measure)
  const full = `${label}: ${action}`
  if (measure(full) <= maxWidth) return full
  const prefix = `${label}: `
  const room = maxWidth - measure(prefix)
  if (room < measure('\u2026') * 6) return middleTruncate(full, maxWidth, measure)
  return prefix + middleTruncate(action, room, measure)
}
