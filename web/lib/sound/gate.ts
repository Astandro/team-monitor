// Rules that decide whether a cue actually plays: a quiet window after mount or a session switch (the graph replays
// a session's history, which must not sound like a hundred tool calls), and a minimum gap per cue so bursts do not
// machine-gun. Pure and clock-injected, so it is unit tested (gate.test.ts).

import { orderCues, type SoundCue } from './cues'

/** Minimum time between two plays of the same cue, in ms. Cues not listed use DEFAULT_GAP_MS. */
export const MIN_GAP_MS: Partial<Record<SoundCue, number>> = {
  tool_start: 220,
  tool_complete: 220,
  handoff: 250,
  tool_error: 600,
  agent_spawn: 400,
  agent_complete: 400,
  session_start: 2000,
}
export const DEFAULT_GAP_MS = 300

/** Silence after the graph mounts or switches session, while buffered history replays. */
export const QUIET_AFTER_RESET_MS = 1500

/** A new session switches the graph (which starts a quiet window) at the same moment; its power-up still plays. */
const QUIET_EXEMPT: ReadonlySet<SoundCue> = new Set<SoundCue>(['session_start'])

/** Gap between cues that fire in the same instant, so they do not blur into one noise. */
export const STAGGER_MS = 180

/** At most this many different cues per instant; the most important ones win. */
export const MAX_CUES_PER_BATCH = 3

export class SoundGate {
  private quietUntil = -Infinity
  private lastPlayed = new Map<SoundCue, number>()

  /** Start a quiet window (mount, session switch). */
  reset(now: number, quietMs: number = QUIET_AFTER_RESET_MS): void {
    this.quietUntil = now + quietMs
  }

  /** Cues allowed to play now, most important first, unique, rate-limited, capped. Records what it lets through. */
  admit(cues: Iterable<SoundCue>, now: number): SoundCue[] {
    const quiet = now < this.quietUntil
    const out: SoundCue[] = []
    for (const cue of orderCues(cues)) {
      if (out.length >= MAX_CUES_PER_BATCH) break
      if (quiet && !QUIET_EXEMPT.has(cue)) continue
      const gap = MIN_GAP_MS[cue] ?? DEFAULT_GAP_MS
      const last = this.lastPlayed.get(cue)
      if (last !== undefined && now - last < gap) continue
      this.lastPlayed.set(cue, now)
      out.push(cue)
    }
    return out
  }
}

/** Allowed to start the clock skew between the relay and a phone: a session this much older still counts. */
export const SESSION_START_SLACK_MS = 5000

/**
 * Sessions that really started while the page was open: not seen before and started after `since` (page load).
 * Sessions listed on load are older, so loading the page never sounds like a power-up.
 */
export function startedSessions(
  seen: ReadonlySet<string>,
  sessions: readonly { id: string; startTime: number }[],
  since: number,
): string[] {
  return sessions
    .filter((s) => !seen.has(s.id) && s.startTime >= since - SESSION_START_SLACK_MS)
    .map((s) => s.id)
}
