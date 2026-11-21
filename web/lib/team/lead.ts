// Who leads the team tree, and who is no longer part of it (spec 0.9.8 item 9, AC5). Pure: the caller passes `now`.
//
// One lead. state.json may hold several `desk: "coordinator"` entries (an earlier run's coordinator that was never
// cleaned up, a coordinator spawned again after a restart). The lead is, in this order:
//   1. the coordinator entry named by `meta.coordinator.name` (matched on nick, else on the key, case-insensitive);
//   2. else the first coordinator in state order that is not offboarding (working or idle);
//   3. else the first coordinator in state order.
// Every other coordinator is not a member under the lead: it is "retired" and drawn in the Disintegrating group.
//
// Offboarded members. The hub's offboard list (GET /api/team/offboarded?project=…, the "Selesai kontrak" rows) names
// agents by their personal name (`name`, the instance's displayName, e.g. "Hiro") and node name (`agent`). A member
// whose nick equals a record's name (case-insensitive; when both carry a role, the roles must match too), or whose
// key equals a record's agent, is hidden from the tree, unless it works again after the offboard (isHiddenByOffboard).
// The lead is never hidden.

import type { TeamAgent, TeamMeta } from './types'
import type { OffboardRecord } from './offboard'
import { memberPhase } from './members'

function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLocaleLowerCase() : ''
}

/** Key of the lead among `agents` (already in display order and without gone members); null when none is a coordinator. */
export function pickLeadId(
  agents: readonly [string, TeamAgent][],
  meta: TeamMeta | undefined,
  now: number,
): string | null {
  const coordinators = agents.filter(([, a]) => a && a.desk === 'coordinator')
  if (coordinators.length === 0) return null
  const named = norm(meta?.coordinator?.name)
  if (named) {
    const byNick = coordinators.find(([, a]) => norm(a.nick) === named)
    if (byNick) return byNick[0]
    const byKey = coordinators.find(([id]) => norm(id) === named)
    if (byKey) return byKey[0]
  }
  const current = coordinators.find(([, a]) => memberPhase(a, now).kind !== 'offboarding')
  return (current ?? coordinators[0])[0]
}

/** The records of the hub's offboard list that name this member. */
function matchingRecords(id: string, agent: TeamAgent, records: readonly OffboardRecord[] | null | undefined): OffboardRecord[] {
  if (!Array.isArray(records) || records.length === 0) return []
  const nick = norm(agent.nick)
  const role = norm(agent.name)
  const key = norm(id)
  const out: OffboardRecord[] = []
  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    if (key && norm(r.agent) === key) {
      out.push(r)
      continue
    }
    if (!nick || norm(r.name) !== nick) continue
    const recRole = norm(r.role)
    if (recRole && role && recRole !== role) continue
    out.push(r)
  }
  return out
}

/** Is this member in the hub's offboard list of the project. */
export function isOffboardedMember(id: string, agent: TeamAgent, records: readonly OffboardRecord[] | null | undefined): boolean {
  return matchingRecords(id, agent, records).length > 0
}

function timeOf(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/**
 * Hide this member from the tree because the hub offboarded it (spec 0.9.8 item 9, revised for QA finding F2).
 * A member matched by an offboard record (isOffboardedMember) stays visible only when there is evidence it works
 * again after that offboard: its state.json `status` is `working` AND the state file was written (`stateMtime`, from
 * the team_state message) after the record's `offboardedAt`; with several matching records, after the latest one.
 * Every other case hides it: not working, `stateMtime` null/absent/unparseable, a matching record without a readable
 * `offboardedAt`, or a state file not newer than the offboard. Names are reused across sessions of one run, so a
 * container that continues the job brings a member of the same name back to work.
 */
export function isHiddenByOffboard(
  id: string,
  agent: TeamAgent,
  records: readonly OffboardRecord[] | null | undefined,
  stateMtime: string | null | undefined,
): boolean {
  const matched = matchingRecords(id, agent, records)
  if (matched.length === 0) return false
  if (agent.status !== 'working') return true
  const written = timeOf(stateMtime)
  if (written === null) return true
  let latest = -Infinity
  for (const r of matched) {
    const t = timeOf(r.offboardedAt)
    if (t === null) return true
    if (t > latest) latest = t
  }
  return !(written > latest)
}
