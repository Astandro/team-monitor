// Sessions and projects that come from a Claude Code cloud container through the hub (spec team-monitor-cloud, D).
// The server adds three optional fields to session-list entries, session-started / session-updated messages and
// /api/team/projects rows; local items omit them, so everything here is a no-op for them. Pure: no DOM, no clock.

/** The optional fields a cloud item carries. */
export interface CloudFields {
  /** "cloud" for an item forwarded by a cloud container; absent for a local one. */
  origin?: 'cloud'
  /** Which cloud container (one source per container). */
  sourceId?: string
  /** The container stopped reporting; cleared (false or absent) once it reports again. */
  stale?: boolean
}

export const CLOUD_LABEL = 'Cloud'
export const STALE_LABEL = 'Terputus'
export const CLOUD_HINT = 'Sesi ini jalan di container cloud Claude Code, bukan di komputer ini.'
export const STALE_HINT = 'Container cloud-nya lagi nggak ngirim kabar. Yang tampil data terakhir; nyambung lagi sendiri begitu aktif.'
export const STALE_NOTICE = 'Proyek cloud ini lagi nggak ngirim kabar. Yang tampil data terakhir, nanti nyambung lagi sendiri.'

/** What the UI marks on an item. */
export interface OriginMarks {
  cloud: boolean
  stale: boolean
}

export const NO_MARKS: OriginMarks = { cloud: false, stale: false }

/** Marks for a session or project. Unknown values (a typo, a future origin) mark nothing. */
export function originMarks(item: CloudFields | null | undefined): OriginMarks {
  if (!item) return NO_MARKS
  const cloud = item.origin === 'cloud'
  const stale = item.stale === true
  return cloud || stale ? { cloud, stale } : NO_MARKS
}

/**
 * The cloud fields of an untrusted message object, checked: only `origin: "cloud"`, a string `sourceId` and
 * `stale: true` survive. Returns an empty object for a local item, so spreading it adds nothing.
 */
export function cloudFields(raw: unknown): CloudFields {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: CloudFields = {}
  if (r.origin === 'cloud') out.origin = 'cloud'
  if (typeof r.sourceId === 'string' && r.sourceId !== '') out.sourceId = r.sourceId
  if (r.stale === true) out.stale = true
  return out
}

/**
 * Apply the cloud fields of a later message (session-started for a known session, session-updated) to an item.
 * A message describes the item as it is now: `stale` absent or false clears an earlier `stale: true`.
 * `origin` and `sourceId` are kept when the message leaves them out. A local item that gets no fields is returned
 * unchanged (same object).
 */
export function withCloudUpdate<T extends CloudFields>(item: T, raw: unknown): T {
  const f = cloudFields(raw)
  const next: T = { ...item }
  let changed = false
  if (f.origin && item.origin !== f.origin) {
    next.origin = f.origin
    changed = true
  }
  if (f.sourceId && item.sourceId !== f.sourceId) {
    next.sourceId = f.sourceId
    changed = true
  }
  if (f.stale && item.stale !== true) {
    next.stale = true
    changed = true
  } else if (!f.stale && item.stale !== undefined) {
    delete next.stale
    changed = true
  }
  return changed ? next : item
}

interface ProjectRow extends CloudFields {
  id: string
  name: string
  hasState: boolean
}

/** Same project list as far as the panel draws it (id, name, data, cloud marks), in the same order. */
export function sameProjects(a: readonly ProjectRow[], b: readonly ProjectRow[]): boolean {
  if (a.length !== b.length) return false
  return a.every((p, i) => {
    const q = b[i]
    if (p.id !== q.id || p.name !== q.name || p.hasState !== q.hasState) return false
    const mp = originMarks(p)
    const mq = originMarks(q)
    return mp.cloud === mq.cloud && mp.stale === mq.stale && (p.sourceId ?? '') === (q.sourceId ?? '')
  })
}

/** Text after a project's name in the switcher (a native select, so plain text): "", " · Cloud", " · Cloud · Terputus". */
export function originSuffix(marks: OriginMarks): string {
  const parts: string[] = []
  if (marks.cloud) parts.push(CLOUD_LABEL)
  if (marks.stale) parts.push(STALE_LABEL)
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

/** Tooltip for the marks on a tab or the project header; empty when there is nothing to explain. */
export function originHint(marks: OriginMarks): string {
  if (marks.stale) return STALE_HINT
  if (marks.cloud) return CLOUD_HINT
  return ''
}
