// Unread replies from the coordinator in the chat (spec-chat-layout, owner 13 Nov). Pure, so the rules are tested.
//
// "Unread" = coordinator replies that arrived after the owner last had the chat on screen, per project, remembered per
// browser. The mark is the last reply seen (its id, and a time as a fallback when that id is no longer in the list).
// A project this browser has never shown starts with everything as seen: opening the page for the first time must not
// greet the owner with a badge for the whole history (the same rule as the sounds: silent on the first payload).

import type { ChatEntry } from './chat'

export const CHAT_SEEN_KEY = 'tm-chat-seen'

export interface SeenMark {
  /** id of the last coordinator reply the owner saw; empty when there was none yet */
  id: string
  /** ISO time of that reply (or of the newest entry / the moment of viewing when there was no reply) */
  t: string
}

export type SeenMarks = Record<string, SeenMark>

function isReply(e: ChatEntry | null | undefined): e is ChatEntry & { id: string } {
  return !!e && e.from !== 'owner' && typeof e.id === 'string' && e.id !== '' && typeof e.text === 'string'
}

/** The mark that says "everything up to now was seen". */
export function seenMark(chat: readonly ChatEntry[] | null | undefined, nowIso: string): SeenMark {
  const list = Array.isArray(chat) ? chat : []
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]
    if (isReply(e)) return { id: e.id, t: typeof e.t === 'string' && !Number.isNaN(Date.parse(e.t)) ? e.t : nowIso }
  }
  // no reply yet: anything the coordinator writes after the newest entry (or after now) is new
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]?.t
    if (typeof t === 'string' && !Number.isNaN(Date.parse(t))) return { id: '', t }
  }
  return { id: '', t: nowIso }
}

/**
 * Replies after the mark. The server keeps `chat` sorted oldest first, so "after" is by position when the marked
 * reply is still in the list, else by time. No mark (never shown in this browser) counts nothing.
 */
export function unreadCount(chat: readonly ChatEntry[] | null | undefined, mark: SeenMark | null | undefined): number {
  if (!mark) return 0
  const list = Array.isArray(chat) ? chat : []
  if (mark.id) {
    const at = list.findIndex((e) => isReply(e) && e.id === mark.id)
    if (at >= 0) return list.slice(at + 1).filter(isReply).length
  }
  const since = Date.parse(mark.t)
  if (Number.isNaN(since)) return 0
  return list.filter((e) => {
    if (!isReply(e) || typeof e.t !== 'string') return false
    const t = Date.parse(e.t)
    return !Number.isNaN(t) && t > since
  }).length
}

/** Reads the stored marks; anything unreadable is dropped, never thrown. */
export function parseSeenMarks(raw: string | null | undefined): SeenMarks {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: SeenMarks = {}
    for (const [k, m] of Object.entries(v as Record<string, unknown>)) {
      if (!m || typeof m !== 'object') continue
      const { id, t } = m as Record<string, unknown>
      if (typeof id === 'string' && typeof t === 'string') out[k] = { id, t }
    }
    return out
  } catch {
    return {}
  }
}

export function storeSeenMarks(marks: SeenMarks): string {
  return JSON.stringify(marks)
}

/**
 * The next marks for one project, or null when nothing changes (so the caller does not re-render or write):
 * - first payload of a project this browser never showed: baseline, everything counts as seen;
 * - chat on screen: mark the newest reply as seen.
 */
export function nextSeenMarks(
  marks: SeenMarks,
  project: string | null,
  chat: readonly ChatEntry[] | null | undefined,
  viewing: boolean,
  nowIso: string,
): SeenMarks | null {
  if (!project || !chat) return null
  const have = marks[project]
  if (have && !viewing) return null
  const mark = seenMark(chat, nowIso)
  if (have && have.id === mark.id && (mark.id !== '' || unreadCount(chat, have) === 0)) return null
  return { ...marks, [project]: mark }
}

/** Badge text: "9+" past nine, empty for none. */
export function unreadBadge(n: number): string {
  if (n <= 0) return ''
  return n > 9 ? '9+' : String(n)
}

/** Words for screen readers next to the badge. */
export function unreadLabel(n: number, coordinatorName: string): string {
  if (n <= 0) return ''
  return n === 1 ? `1 balasan baru dari ${coordinatorName}` : `${n} balasan baru dari ${coordinatorName}`
}
