// Team list in three groups (owner feedback 13 Nov): "Aktif" (working, with the current task), "Siaga" (idle), and
// "Disintegrating" last on its own tinted background. Groups with nobody in them are not shown. The coordinator is
// not part of these groups: it stays on top of the tree. Pure; members keep their state.json order inside a group.

export type MemberGroupKey = 'active' | 'idle' | 'leaving'

export const MEMBER_GROUP_LABEL: Record<MemberGroupKey, string> = {
  active: 'Aktif',
  idle: 'Siaga',
  leaving: 'Disintegrating',
}

const ORDER: MemberGroupKey[] = ['active', 'idle', 'leaving']

export interface MemberGroup<T> {
  key: MemberGroupKey
  label: string
  members: T[]
}

type Groupable = { phase: 'working' | 'idle' | 'offboarding'; retired?: boolean }

/** A coordinator that is not the lead (`retired`, lib/team/lead.ts) goes to Disintegrating whatever its status. */
export function memberGroupOf(m: Groupable): MemberGroupKey {
  if (m.retired) return 'leaving'
  return m.phase === 'offboarding' ? 'leaving' : m.phase === 'working' ? 'active' : 'idle'
}

export function groupMembers<T extends Groupable>(members: readonly T[]): MemberGroup<T>[] {
  const by: Record<MemberGroupKey, T[]> = { active: [], idle: [], leaving: [] }
  for (const m of members) by[memberGroupOf(m)].push(m)
  return ORDER.filter((k) => by[k].length > 0).map((k) => ({ key: k, label: MEMBER_GROUP_LABEL[k], members: by[k] }))
}
