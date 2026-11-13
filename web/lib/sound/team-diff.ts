// Which team panel sounds a state change asks for. Pure: compares two consecutive state.json snapshots of the
// same project. The tracker below keeps the previous snapshot and stays silent on the first payload and right
// after a project switch, so opening the page or switching projects never plays a burst of old news.

import type { TeamApproval, TeamState } from '@/lib/team/types'
import { orderCues, type SoundCue } from './cues'

const TASK_CUES: Record<string, SoundCue> = {
  running: 'task_start',
  review: 'task_review',
  done: 'task_done',
  blocked: 'task_blocked',
}

function isAnswered(ap: TeamApproval | undefined): boolean {
  if (!ap) return false
  return ap.status === 'answered' || (typeof ap.answer === 'string' && ap.answer.trim() !== '')
}

/**
 * Cues for everything that changed from `prev` to `next`, unique and most important first.
 * A task or stage that is new counts as changed from "nothing"; a decision only counts once it is seen open.
 */
export function diffTeamStates(prev: TeamState, next: TeamState): SoundCue[] {
  const cues: SoundCue[] = []

  const prevApprovals = prev.approvals ?? {}
  for (const [id, ap] of Object.entries(next.approvals ?? {})) {
    if (!ap) continue
    const before = prevApprovals[id]
    const nowAnswered = isAnswered(ap)
    if (!nowAnswered && (!before || isAnswered(before))) cues.push('decision_open')
    if (nowAnswered && before && !isAnswered(before)) cues.push('decision_answered')
  }

  const prevTasks = prev.tasks ?? {}
  for (const [id, t] of Object.entries(next.tasks ?? {})) {
    const status = t?.status
    if (!status || status === prevTasks[id]?.status) continue
    const cue = TASK_CUES[status]
    if (cue) cues.push(cue)
  }

  const prevStages = prev.stages ?? {}
  for (const [id, st] of Object.entries(next.stages ?? {})) {
    if (st?.status === 'done' && prevStages[id]?.status !== 'done') cues.push('stage_done')
  }

  return orderCues(cues)
}

/** Remembers the last snapshot per selected project and turns each new payload into cues. */
export class TeamSoundTracker {
  private project: string | null = null
  private last: TeamState | null = null

  /** Feed every payload; returns the cues to play (empty on the first payload and after a project switch). */
  step(project: string | null, state: TeamState | null | undefined): SoundCue[] {
    if (project !== this.project) {
      this.project = project
      this.last = state ?? null
      return []
    }
    // a payload without state (read error, file missing) keeps the last good one as the baseline
    if (!state) return []
    const prev = this.last
    this.last = state
    if (!prev) return []
    return diffTeamStates(prev, state)
  }
}
