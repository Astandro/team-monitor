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
// key equals a record's agent, is hidden from the tree. The lead is never hidden.

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

/** Is this member in the hub's offboard list of the project. */
export function isOffboardedMember(id: string, agent: TeamAgent, records: readonly OffboardRecord[] | null | undefined): boolean {
  if (!Array.isArray(records) || records.length === 0) return false
  const nick = norm(agent.nick)
  const role = norm(agent.name)
  const key = norm(id)
  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    if (key && norm(r.agent) === key) return true
    if (!nick || norm(r.name) !== nick) continue
    const recRole = norm(r.role)
    if (recRole && role && recRole !== role) continue
    return true
  }
  return false
}
