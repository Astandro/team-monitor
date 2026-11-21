"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { submitAnswer, type AnswerResult, type FetchLike } from '@/lib/team/answer'
import { makeFixtureFetch, makeFixtureState, FIXTURE_PROJECTS } from '@/lib/team/fixtures/sample'
import {
  addLocalAnswer,
  hasTeamData,
  localAnswersFor,
  panelView,
  pickProject,
  plainStateError,
  reconnectDelay,
  type LocalAnswers,
  type PanelView,
} from '@/lib/team/session'
import type { TeamProject, TeamState, TeamStatePayload } from '@/lib/team/types'
import { buildTeamVM, type TeamVM } from '@/lib/team/view-model'
import {
  buildThread,
  coordinatorName as coordinatorNameOf,
  pruneLocal,
  submitMessage,
  watcherNotice,
  type ChatEntry,
  type ChatItem,
  type LocalMessage,
  type MessageResult,
} from '@/lib/team/chat'
import { OFFBOARDED_EVENT, offboardRows, type OffboardRecord, type OffboardRow } from '@/lib/team/offboard'
import type { PostFetch } from '@/lib/team/post'
import { originMarks, sameProjects, type OriginMarks } from '@/lib/cloud-origin'
import { readStored, writeStored } from './storage'

export type OffboardedList =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: OffboardRow[] }

const NO_CHAT: ChatEntry[] = []
const NO_LOCAL: LocalMessage[] = []
const postFetch: PostFetch = (url, init) => fetch(url, init)
const fixturePost: PostFetch = async (_url, init) => {
  await new Promise((r) => setTimeout(r, 500))
  const body = JSON.parse(init.body) as { text: string }
  if (/error/i.test(body.text)) return { status: 429, json: async () => ({ ok: false }), headers: { get: () => '30' } }
  return { status: 200, json: async () => ({ ok: true, id: `fx${Date.now()}`, sentAt: new Date().toISOString() }) }
}

// Replaced by a constant at build time (web/vite.config.app.ts). In a normal build this is false, the fixture
// branches below are removed, and the sample data does not end up in the page.
const FIXTURE = process.env.TEAM_MONITOR_FIXTURE === '1'
const PROJECT_KEY = 'tm-project'
/** How often a loaded project list is re-read (the hub marks a cloud source stale after 60 s without news). */
const PROJECTS_REFRESH_MS = 15_000

export type Connection = 'connecting' | 'live' | 'reconnecting'

export interface TeamModel {
  view: PanelView
  connection: Connection
  listError: string
  stateError: string
  projects: TeamProject[]
  selectedId: string | null
  selectProject: (id: string) => void
  projectName: string
  /** Cloud / Terputus marks of the selected project (both false for a local one) */
  projectMarks: OriginMarks
  vm: TeamVM
  /** raw state of the selected project (null until its first payload); the sound tracker diffs it */
  state: TeamState | null
  sendAnswer: (decisionId: string, answer: string) => Promise<AnswerResult>
  retryProjects: () => void
  fixture: boolean
  /** True once the selected project's first payload arrived (the chat can show) */
  hasPayload: boolean
  /** Raw chat of the selected project (null until its first payload); the sound tracker diffs it */
  chat: ChatEntry[] | null
  thread: ChatItem[]
  coordinatorName: string
  /** "Sora lagi nggak aktif, pesan disimpan…" or empty */
  watcherNotice: string
  sendMessage: (text: string) => Promise<MessageResult>
  offboarded: OffboardedList
  reloadOffboarded: () => void
}

function goToLogin() {
  window.location.assign('/login')
}

export function useTeamModel(): TeamModel {
  const [projects, setProjects] = useState<TeamProject[]>([])
  const [loaded, setLoaded] = useState(false)
  const [listError, setListError] = useState('')
  const [chosen, setChosen] = useState<string | null>(() => (typeof window === 'undefined' ? null : readStored(PROJECT_KEY)))
  const [payload, setPayload] = useState<TeamStatePayload | null>(null)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [localAnswers, setLocalAnswers] = useState<LocalAnswers>({})
  const [now, setNow] = useState(() => Date.now())

  const selected = useMemo(() => pickProject(projects, chosen), [projects, chosen])
  const selectedId = selected?.id ?? null

  const loadProjects = useCallback(async () => {
    if (FIXTURE) {
      setProjects(FIXTURE_PROJECTS)
      setLoaded(true)
      return
    }
    try {
      const res = await fetch('/api/team/projects', { credentials: 'same-origin' })
      if (res.status === 401) return goToLogin()
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as { projects?: TeamProject[] }
      const list = Array.isArray(body.projects) ? body.projects : []
      // the list is re-read every few seconds: keep the same array while nothing changed, so nothing re-renders
      setProjects((prev) => (sameProjects(prev, list) ? prev : list))
      setListError('')
    } catch {
      setListError('Daftar proyek belum bisa dimuat. Dicoba lagi otomatis.')
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // while the list failed or is empty, keep asking every few seconds so a project that appears shows up
  useEffect(() => {
    if (FIXTURE || (!listError && projects.length > 0)) return
    const t = setInterval(() => void loadProjects(), 5000)
    return () => clearInterval(t)
  }, [listError, projects.length, loadProjects])

  // A cloud project appears at runtime and turns "Terputus" when its container stops reporting (stale), so a loaded
  // list is re-read too, while the page is visible. For local projects nothing on screen changes.
  useEffect(() => {
    if (FIXTURE || listError || projects.length === 0) return
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void loadProjects()
    }, PROJECTS_REFRESH_MS)
    return () => clearInterval(t)
  }, [listError, projects.length, loadProjects])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  // live state of the selected project
  useEffect(() => {
    setPayload(null)
    if (!selectedId) return
    if (FIXTURE) {
      setPayload({ project: selectedId, state: makeFixtureState(selectedId, Date.now()), error: null })
      setConnection('live')
      return
    }
    let es: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let stopped = false

    const connect = () => {
      if (stopped) return
      setConnection(attempt === 0 ? 'connecting' : 'reconnecting')
      const source = new EventSource(`/api/team/events?project=${encodeURIComponent(selectedId)}`)
      es = source
      source.onopen = () => {
        attempt = 0
        setConnection('live')
      }
      source.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as TeamStatePayload
          if (data.type !== 'team_state' || (data.project && data.project !== selectedId)) return
          attempt = 0
          setConnection('live')
          setPayload({
            project: selectedId,
            state: data.state ?? null,
            error: data.error ?? null,
            updatedAt: data.updatedAt,
            chat: Array.isArray(data.chat) ? data.chat : [],
            watcher: data.watcher,
          })
          setNow(Date.now())
        } catch {
          /* ignore a frame we cannot read */
        }
      }
      source.onerror = () => {
        source.close()
        if (stopped) return
        setConnection('reconnecting')
        // a closed stream with no session means the cookie expired: ask the list endpoint, it answers 401
        void loadProjects()
        timer = setTimeout(connect, reconnectDelay(attempt++))
      }
    }
    connect()

    // phones freeze background tabs: reconnect at once when the tab comes back
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return
      if (es && es.readyState === EventSource.OPEN) return
      if (timer) clearTimeout(timer)
      es?.close()
      attempt = 0
      connect()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      es?.close()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [selectedId, loadProjects])

  // a payload that belongs to the previously selected project does not count for this one
  const current = payload !== null && payload.project === selectedId ? payload : null
  const state: TeamState | null = current?.state ?? null
  const view = panelView(loaded, projects, hasTeamData(state), current !== null)
  const projectName = selected?.name ?? ''
  const shownAnswers = localAnswersFor(localAnswers, selectedId)
  // The hub's offboard list hides those members from the tree (spec 0.9.8 item 9); declared further down with the
  // "Selesai kontrak" list, read here through the state it fills
  const [offboardedRaw, setOffboardedRaw] = useState<OffboardRecord[] | null>(null)
  const vm = useMemo(
    () => buildTeamVM(state, { now, localAnswers: shownAnswers, projectName, offboarded: offboardedRaw }),
    [state, now, shownAnswers, projectName, offboardedRaw],
  )

  const fetchRef = useRef<FetchLike>(
    FIXTURE ? makeFixtureFetch() : (url, init) => fetch(url, init) as ReturnType<FetchLike>,
  )

  const sendAnswer = useCallback(
    async (decisionId: string, answer: string): Promise<AnswerResult> => {
      if (!selectedId) return { ok: false, kind: 'error', status: 0, message: 'Belum ada proyek yang dipilih.' }
      const result = await submitAnswer(fetchRef.current, selectedId, decisionId, answer)
      // keyed by the project this answer was sent to, so a reply that lands after a switch cannot close
      // a same-named decision in another project
      if (result.ok) setLocalAnswers((prev) => addLocalAnswer(prev, selectedId, decisionId, answer.trim()))
      else if (result.kind === 'login') goToLogin()
      return result
    },
    [selectedId],
  )

  const selectProject = useCallback((id: string) => {
    setChosen(id)
    writeStored(PROJECT_KEY, id)
  }, [])

  // ─── Chat (spec-chat) ───
  const chat: ChatEntry[] | null = useMemo(() => (current ? (current.chat ?? NO_CHAT) : null), [current])
  const [localMessages, setLocalMessages] = useState<{ project: string; list: LocalMessage[] }>({ project: '', list: [] })
  const shownLocal = localMessages.project === selectedId ? localMessages.list : NO_LOCAL
  // drop sent messages once the stream delivered them
  useEffect(() => {
    if (!chat || shownLocal.length === 0) return
    const pruned = pruneLocal(shownLocal, chat)
    if (pruned.length !== shownLocal.length) setLocalMessages({ project: selectedId ?? '', list: pruned })
  }, [chat, shownLocal, selectedId])
  const coordinatorName = coordinatorNameOf(state?.meta, state?.agents)
  const thread = useMemo(
    () => buildThread(chat, { now, coordinatorName, local: shownLocal }),
    [chat, now, coordinatorName, shownLocal],
  )

  const sendMessage = useCallback(
    async (text: string): Promise<MessageResult> => {
      if (!selectedId) {
        return { ok: false, kind: 'error', status: 0, message: 'Belum ada proyek yang dipilih.', retryAfter: null }
      }
      const result = await submitMessage(FIXTURE ? fixturePost : postFetch, selectedId, text)
      if (result.ok) {
        const msg = { id: result.id, text: text.replace(/\r\n?/g, '\n').trim(), sentAt: result.sentAt }
        setLocalMessages((prev) => ({
          project: selectedId,
          list: [...(prev.project === selectedId ? prev.list : []), msg],
        }))
        setNow(Date.now())
      } else if (result.kind === 'login') goToLogin()
      return result
    },
    [selectedId],
  )

  // ─── "Selesai kontrak" (offboarded agents of this project) ───
  const [offboarded, setOffboarded] = useState<OffboardedList>({ status: 'loading' })
  const loadOffboarded = useCallback(async () => {
    if (!selectedId) return
    if (FIXTURE) {
      setOffboardedRaw([])
      return
    }
    try {
      const res = await fetch(`/api/team/offboarded?project=${encodeURIComponent(selectedId)}`, { credentials: 'same-origin' })
      if (res.status === 401) return goToLogin()
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as { offboarded?: OffboardRecord[] }
      setOffboardedRaw(Array.isArray(body.offboarded) ? body.offboarded : [])
    } catch {
      setOffboarded({ status: 'error', message: 'Daftar Selesai kontrak belum bisa dimuat.' })
    }
  }, [selectedId])
  useEffect(() => {
    setOffboardedRaw(null)
    setOffboarded({ status: 'loading' })
    void loadOffboarded()
    const onOffboarded = () => void loadOffboarded()
    window.addEventListener(OFFBOARDED_EVENT, onOffboarded)
    return () => window.removeEventListener(OFFBOARDED_EVENT, onOffboarded)
  }, [loadOffboarded])
  useEffect(() => {
    if (offboardedRaw) setOffboarded({ status: 'ready', rows: offboardRows(offboardedRaw, now) })
  }, [offboardedRaw, now])

  return {
    view,
    connection,
    listError,
    stateError: current?.error ? plainStateError(current.error) : '',
    projects,
    selectedId,
    selectProject,
    projectName,
    projectMarks: originMarks(selected),
    vm,
    state,
    sendAnswer,
    retryProjects: () => void loadProjects(),
    fixture: FIXTURE,
    hasPayload: current !== null,
    chat,
    thread,
    coordinatorName,
    watcherNotice: watcherNotice(current?.watcher, coordinatorName),
    sendMessage,
    offboarded,
    reloadOffboarded: () => void loadOffboarded(),
  }
}
