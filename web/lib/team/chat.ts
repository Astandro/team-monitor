// Chat with the coordinator (spec-chat, D25): thread, status labels, send request and its failures. Pure.
// Server contract: handover takumi-chat-server.md. `chat` is a sorted array next to `state` in every payload;
// owner entries carry status sent|read, every other `from` is the coordinator's reply.

import { isOk, postTeam, serverError, type PostFetch } from './post'

export const MAX_MESSAGE_LENGTH = 4000
/** The counter shows from here on, so it only appears when the limit matters. */
export const COUNTER_FROM = 3600
export const DEFAULT_COORDINATOR_NAME = 'Sora'

export interface ChatEntry {
  id?: string
  from?: string
  text?: string
  t?: string
  status?: string
  readAt?: string
}

export interface WatcherInfo {
  alive?: boolean
  since?: string | null
}

export interface ChatItem {
  id: string
  mine: boolean
  /** Who wrote it, as shown: "Kamu" or the coordinator's name. */
  who: string
  text: string
  time: string
  /** Owner messages only: "Terkirim" / "Dibaca Sora"; empty for replies. */
  status: string
  read: boolean
}

/** A message this browser sent that the stream has not echoed yet. */
export interface LocalMessage {
  id: string
  text: string
  sentAt: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** "14.05" today, "13 Nov 14.05" on another day (local time). Empty for an unreadable time. */
export function chatTime(iso: unknown, now: number): string {
  if (typeof iso !== 'string') return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = new Date(t)
  const n = new Date(now)
  const clock = `${pad(d.getHours())}.${pad(d.getMinutes())}`
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? clock : `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock}`
}

export function chatStatusLabel(status: unknown, coordinatorName: string): string {
  if (status === 'read') return `Dibaca ${coordinatorName}`
  if (status === 'sent') return 'Terkirim'
  return ''
}

/**
 * Name used in the chat for the coordinator. The documented place is state.json `meta.coordinator.name`
 * (docs/coordinator.md); coordinators also write `meta.coordinator` as a plain string, `meta.run.coordinator`
 * (string or object), or only list themselves as the agent with `desk: "coordinator"`. All of those count, in that
 * order; "Sora" only when none is there.
 */
export function coordinatorName(
  meta: { coordinator?: unknown; run?: unknown } | undefined | null,
  agents?: unknown,
): string {
  const fromValue = (c: unknown): string => {
    if (typeof c === 'string') return c.trim()
    if (c && typeof c === 'object') {
      const name = (c as Record<string, unknown>).name
      if (typeof name === 'string') return name.trim()
    }
    return ''
  }
  const run = meta?.run && typeof meta.run === 'object' ? (meta.run as Record<string, unknown>) : null
  const direct = fromValue(meta?.coordinator) || fromValue(run?.coordinator)
  if (direct) return direct.slice(0, 60)
  if (agents && typeof agents === 'object') {
    for (const a of Object.values(agents as Record<string, unknown>)) {
      if (!a || typeof a !== 'object') continue
      const r = a as Record<string, unknown>
      if (r.desk === 'coordinator' && typeof r.nick === 'string' && r.nick.trim()) return r.nick.trim().slice(0, 60)
    }
  }
  return DEFAULT_COORDINATOR_NAME
}

/**
 * The thread as drawn: served entries in server order (oldest first), then messages this browser sent that the
 * stream has not delivered yet (shown as "Terkirim": the server answered 200, so they are on disk).
 */
export function buildThread(
  chat: readonly ChatEntry[] | null | undefined,
  opts: { now: number; coordinatorName: string; local?: readonly LocalMessage[] },
): ChatItem[] {
  const items: ChatItem[] = []
  const seen = new Set<string>()
  const list = Array.isArray(chat) ? chat : []
  list.forEach((e, i) => {
    if (!e || typeof e.text !== 'string') return
    const id = typeof e.id === 'string' && e.id ? e.id : `row-${i}`
    seen.add(id)
    const mine = e.from === 'owner'
    const status = mine ? (e.status === 'read' ? 'read' : 'sent') : ''
    items.push({
      id,
      mine,
      who: mine ? 'Kamu' : opts.coordinatorName,
      text: e.text,
      time: chatTime(e.t, opts.now),
      status: mine ? chatStatusLabel(status, opts.coordinatorName) : '',
      read: status === 'read',
    })
  })
  for (const m of opts.local ?? []) {
    if (seen.has(m.id)) continue
    items.push({
      id: m.id,
      mine: true,
      who: 'Kamu',
      text: m.text,
      time: chatTime(m.sentAt, opts.now),
      status: chatStatusLabel('sent', opts.coordinatorName),
      read: false,
    })
  }
  return items
}

/** Local messages the stream has now delivered are dropped. */
export function pruneLocal(local: readonly LocalMessage[], chat: readonly ChatEntry[] | null | undefined): LocalMessage[] {
  const ids = new Set((Array.isArray(chat) ? chat : []).map((e) => e?.id))
  return local.filter((m) => !ids.has(m.id))
}

/** Text shown when nobody is watching the inbox; empty when the watcher is alive or the server did not say. */
export function watcherNotice(watcher: WatcherInfo | null | undefined, name: string): string {
  if (!watcher || watcher.alive !== false) return ''
  return `${name} lagi nggak aktif, pesan disimpan. Dibaca begitu sesinya jalan lagi.`
}

/** "3700/4000" near the limit, else empty. */
export function counterText(length: number): string {
  return length >= COUNTER_FROM ? `${length}/${MAX_MESSAGE_LENGTH}` : ''
}

/** What the server would accept: CRLF as LF, outer whitespace trimmed, 1..4000 characters. Null otherwise. */
export function cleanMessage(raw: string): string | null {
  const text = raw.replace(/\r\n?/g, '\n').trim()
  if (!text || text.length > MAX_MESSAGE_LENGTH) return null
  return text
}

/** Enter sends, Shift+Enter (or any modifier) is a new line; on a touch keyboard Enter is always a new line. */
export function enterSends(key: { key: string; shiftKey: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean }, coarsePointer: boolean): boolean {
  if (coarsePointer || key.key !== 'Enter' || key.isComposing) return false
  return !key.shiftKey && !key.altKey && !key.ctrlKey && !key.metaKey
}

export type MessageResult =
  | { ok: true; id: string; sentAt: string }
  | { ok: false; kind: 'login' | 'error' | 'limit'; status: number; message: string; retryAfter: number | null }

export function mapMessageError(
  status: number,
  detail: string,
  retryAfter: number | null,
): { kind: 'login' | 'error' | 'limit'; message: string } {
  switch (status) {
    case 401:
      return { kind: 'login', message: 'Sesi kamu habis. Masuk lagi dulu.' }
    case 403:
      return { kind: 'error', message: 'Server nolak pesan ini. Muat ulang halaman lalu coba lagi.' }
    case 404:
      return { kind: 'error', message: 'Proyek ini sudah nggak ada di server.' }
    case 429:
      return {
        kind: 'limit',
        message:
          retryAfter !== null
            ? `Terlalu banyak pesan dalam semenit. Coba lagi dalam ${retryAfter} detik.`
            : 'Terlalu banyak pesan dalam semenit. Tunggu sebentar lalu coba lagi.',
      }
    case 0:
      return { kind: 'error', message: 'Nggak bisa nyambung ke server. Pesan belum terkirim, coba lagi.' }
    case 400:
      return { kind: 'error', message: detail ? `Pesan nggak diterima: ${detail}` : 'Pesan nggak diterima.' }
    default:
      return { kind: 'error', message: detail ? `Gagal kirim pesan: ${detail}` : `Gagal kirim pesan (kode ${status}).` }
  }
}

export async function submitMessage(fetchFn: PostFetch, project: string, raw: string): Promise<MessageResult> {
  const text = cleanMessage(raw)
  if (text === null) {
    return {
      ok: false,
      kind: 'error',
      status: 400,
      message: `Pesan kosong atau kepanjangan (maksimal ${MAX_MESSAGE_LENGTH} huruf).`,
      retryAfter: null,
    }
  }
  const out = await postTeam(fetchFn, '/api/team/message', { project, text })
  if (isOk(out) && typeof out.body.id === 'string') {
    return { ok: true, id: out.body.id, sentAt: typeof out.body.sentAt === 'string' ? out.body.sentAt : new Date().toISOString() }
  }
  const status = isOk(out) ? 500 : out.status
  return { ok: false, status, retryAfter: out.retryAfter, ...mapMessageError(status, serverError(out.body), out.retryAfter) }
}

/** Ids of coordinator replies, to notice new ones. */
function replyIds(chat: readonly ChatEntry[] | null | undefined): Set<string> {
  const ids = new Set<string>()
  for (const e of Array.isArray(chat) ? chat : []) {
    if (e && e.from !== 'owner' && typeof e.id === 'string') ids.add(e.id)
  }
  return ids
}

/**
 * Says when a coordinator reply arrived. Silent on the first payload of a project and after a switch, like the
 * team sounds, so opening the page never plays old replies.
 */
export class ChatReplyTracker {
  private project: string | null = null
  private known: Set<string> | null = null

  step(project: string | null, chat: readonly ChatEntry[] | null | undefined): boolean {
    if (project !== this.project) {
      this.project = project
      this.known = chat ? replyIds(chat) : null
      return false
    }
    if (!chat) return false
    const next = replyIds(chat)
    const prev = this.known
    this.known = next
    if (!prev) return false
    for (const id of next) if (!prev.has(id)) return true
    return false
  }
}
