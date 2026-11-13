/**
 * Who the team tree shows (spec-panel-compact item 2). Data convention from the coordinator: a retired instance gets
 * `status: "offboarding"` and `finishedAt`, and is removed from `agents` 60 minutes later. The panel:
 * - shows `working` and `idle` members normally (anything else that is not offboarding counts as idle);
 * - shows an `offboarding` member breaking up over the hour from `finishedAt`, the same clock as the graph's nodes
 *   (web/lib/disintegration.ts);
 * - never shows a member past `finishedAt + 60 min`, even when the coordinator has not removed it yet.
 * An `offboarding` member without a readable `finishedAt` has no clock: it stays at the start of the break-up until
 * the coordinator removes it (hiding it would drop someone who may still be wrapping up).
 * Pure: the caller passes `now`.
 */
import { disintegrationProgress, type FinishedClock } from '../disintegration'

/** Minutes between `finishedAt` and the member leaving the tree. */
export const OFFBOARD_MINUTES = 60

export type MemberPhase =
  | { kind: 'working' }
  | { kind: 'idle' }
  | { kind: 'offboarding'; clock: FinishedClock | null; progress: number }
  | { kind: 'gone' }

export function offboardClock(finishedAt: unknown): FinishedClock | null {
  if (typeof finishedAt !== 'string') return null
  const at = Date.parse(finishedAt)
  if (!Number.isFinite(at)) return null
  return { at, offboardAt: at + OFFBOARD_MINUTES * 60_000 }
}

export function memberPhase(agent: { status?: unknown; finishedAt?: unknown }, now: number): MemberPhase {
  if (agent.status === 'working') return { kind: 'working' }
  if (agent.status !== 'offboarding') return { kind: 'idle' }
  const clock = offboardClock(agent.finishedAt)
  if (!clock) return { kind: 'offboarding', clock: null, progress: 0 }
  if (now >= clock.offboardAt) return { kind: 'gone' }
  return { kind: 'offboarding', clock, progress: disintegrationProgress(clock, now) }
}

/**
 * SVG `stroke-dasharray` for an outline drawn with `pathLength = pieces.length`: alternating runs of drawn and missing
 * pieces, starting with a drawn run (0 when the first piece is missing). Every piece there gives the solid outline
 * ('none'); no piece there gives '0 N' (nothing drawn).
 */
export function dashArrayFromPieces(pieces: boolean[]): string {
  if (pieces.length === 0 || pieces.every(Boolean)) return 'none'
  const runs: number[] = []
  let want = true
  let run = 0
  for (const p of pieces) {
    if (p === want) {
      run++
    } else {
      runs.push(run)
      want = !want
      run = 1
    }
  }
  runs.push(run)
  // an odd count would make the browser repeat the list with on/off swapped: close it with an empty gap
  if (runs.length % 2 === 1) runs.push(0)
  return runs.join(' ')
}
