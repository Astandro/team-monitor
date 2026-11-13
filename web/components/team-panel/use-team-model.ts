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
import { readStored, writeStored } from './storage'

// Replaced by a constant at build time (web/vite.config.app.ts). In a normal build this is false, the fixture
// branches below are removed, and the sample data does not end up in the page.
const FIXTURE = process.env.TEAM_MONITOR_FIXTURE === '1'
const PROJECT_KEY = 'tm-project'

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
  vm: TeamVM
  /** raw state of the selected project (null until its first payload); the sound tracker diffs it */
  state: TeamState | null
  sendAnswer: (decisionId: string, answer: string) => Promise<AnswerResult>
  retryProjects: () => void
  fixture: boolean
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
      setProjects(Array.isArray(body.projects) ? body.projects : [])
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
          setPayload({ project: selectedId, state: data.state ?? null, error: data.error ?? null, updatedAt: data.updatedAt })
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
  const vm = useMemo(
    () => buildTeamVM(state, { now, localAnswers: shownAnswers, projectName }),
    [state, now, shownAnswers, projectName],
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

  return {
    view,
    connection,
    listError,
    stateError: current?.error ? plainStateError(current.error) : '',
    projects,
    selectedId,
    selectProject,
    projectName,
    vm,
    state,
    sendAnswer,
    retryProjects: () => void loadProjects(),
    fixture: FIXTURE,
  }
}
