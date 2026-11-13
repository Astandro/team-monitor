/**
 * Decision answers: validation and the atomic write of `.agent-team/answers/<Dn>.json`.
 *
 * The only part of a path that comes from the request is the decision id, and
 * it must match ^D[0-9]{1,4}$ before it is used. The resolved target is checked
 * to stay inside the answers folder anyway.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { TeamState } from './state-watcher'

export const DECISION_ID_RE = /^D[0-9]{1,4}$/
export const MAX_ANSWER_CHARS = 2000

export class AnswerError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 500, message: string) {
    super(message)
  }
}

export interface AnswerInput { project: string; id: string; answer: string }

/** Shape check of the parsed JSON body. Throws AnswerError(400). */
export function parseAnswerBody(body: unknown): AnswerInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AnswerError(400, 'body must be a JSON object')
  const { project, id, answer } = body as Record<string, unknown>
  if (typeof project !== 'string' || !project) throw new AnswerError(400, 'project is required')
  if (typeof id !== 'string' || !DECISION_ID_RE.test(id)) throw new AnswerError(400, 'id must look like D1..D9999')
  if (typeof answer !== 'string') throw new AnswerError(400, 'answer must be a string')
  const trimmed = answer.trim()
  if (!trimmed) throw new AnswerError(400, 'answer is empty')
  if (trimmed.length > MAX_ANSWER_CHARS) throw new AnswerError(400, `answer is longer than ${MAX_ANSWER_CHARS} characters`)
  return { project, id, answer: trimmed }
}

/** Target file for a validated id, confirmed to stay inside `answersDir`. */
export function answerPath(answersDir: string, id: string): string {
  if (!DECISION_ID_RE.test(id)) throw new AnswerError(400, 'bad decision id')
  const base = path.resolve(answersDir)
  const target = path.resolve(base, `${id}.json`)
  if (path.dirname(target) !== base || !target.startsWith(base + path.sep)) throw new AnswerError(400, 'bad decision id')
  return target
}

/**
 * Check the decision is open in the coordinator's state and has no answer yet,
 * then write the answer atomically (temp file in the same folder, fsync,
 * rename). Everything runs synchronously, so two requests in this process
 * cannot interleave between the check and the rename.
 */
export function writeAnswer(
  rawState: TeamState | null,
  answersDir: string,
  id: string,
  answer: string,
  now: () => Date = () => new Date(),
): { answeredAt: string; file: string } {
  const approvals = rawState?.approvals
  const approval = approvals && typeof approvals === 'object' && !Array.isArray(approvals)
    ? (approvals as Record<string, unknown>)[id]
    : undefined
  if (!approval || typeof approval !== 'object' || !Object.prototype.hasOwnProperty.call(approvals, id)) {
    throw new AnswerError(404, `decision ${id} not found`)
  }
  if ((approval as { status?: unknown }).status !== 'open') throw new AnswerError(409, `decision ${id} is not open`)

  const target = answerPath(answersDir, id)
  ensureAnswersDir(answersDir)
  if (fs.existsSync(target)) throw new AnswerError(409, `decision ${id} is already answered`)

  const answeredAt = now().toISOString()
  const data = JSON.stringify({ answer, answeredAt }, null, 2) + '\n'
  const tmp = path.join(path.dirname(target), `.${id}.json.${crypto.randomBytes(6).toString('hex')}.tmp`)
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
    throw new AnswerError(500, `could not write answer: ${(e as Error).message}`)
  }
  fsyncDir(path.dirname(target))
  return { answeredAt, file: target }
}

function ensureAnswersDir(answersDir: string): void {
  try {
    fs.mkdirSync(answersDir, { recursive: true, mode: 0o700 })
  } catch (e) {
    throw new AnswerError(500, `cannot create answers folder: ${(e as Error).message}`)
  }
  const st = fs.lstatSync(answersDir)
  // A symlinked answers folder could point the write anywhere.
  if (!st.isDirectory() || st.isSymbolicLink()) throw new AnswerError(500, 'answers folder is not a plain directory')
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch { /* not supported everywhere; the rename is already atomic */ }
}
