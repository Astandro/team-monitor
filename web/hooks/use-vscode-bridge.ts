'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { vscodeBridge, type ConnectionStatus, type AgentEvent, type SessionInfo } from '@/lib/vscode-bridge'
import { SimulationEvent } from '@/lib/agent-types'
import type { SessionUpdate } from '@/lib/bridge-types'
import { withCloudUpdate } from '@/lib/cloud-origin'
import { dropOffboardedEvents, OFFBOARDED_EVENT } from '@/lib/team/offboard'
import { applySessionRemoved, applySessionStarted, dedupeSessions, initialSelection, touchActivity } from '@/lib/session-list'

/** Bumped when agents of a session were offboarded; the visualizer rebuilds that session from its buffer. */
export interface OffboardRevision {
  sessionId: string
  seq: number
}

interface BridgeHookResult {
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  /** Events received from VS Code extension, converted to SimulationEvent format */
  pendingEvents: readonly SimulationEvent[]
  /** Call after consuming events to clear the queue */
  consumeEvents: () => void
  /** Whether to show mock data (standalone mode or explicit config) */
  useMockData: boolean
  /** Whether CLAUDE_CODE_DISABLE_1M_CONTEXT=1 is set — caps context window to 200k */
  disable1MContext: boolean
  /** Open a file in the VS Code editor */
  bridgeOpenFile: (filePath: string, line?: number) => void
  /** Known sessions from the extension */
  sessions: SessionInfo[]
  /** Currently selected session ID */
  selectedSessionId: string | null
  /** Select a session to view (does not flush events — call flushSessionEvents after state swap). */
  selectSession: (sessionId: string | null) => void
  /** Flush buffered events for a session into pending. Call from useLayoutEffect after state swap. */
  flushSessionEvents: (sessionId: string, fromIndex?: number) => void
  /** Get the current event count for a session (for save/restore) */
  getSessionEventCount: (sessionId: string) => number
  /** Ref to the currently selected session ID — updated synchronously, not via React state */
  selectedSessionIdRef: React.RefObject<string | null>
  /** Session IDs that have received events while not selected */
  sessionsWithActivity: Set<string>
  /** Remove a session from the list */
  removeSession: (sessionId: string) => void
  /** Last offboarding seen (null before any) */
  offboardRevision: OffboardRevision | null
  /** Drop offboarded agents' buffered events (server message, or our own POST answered 200) */
  applyOffboarded: (sessionId: string, agents: string[]) => void
  /**
   * Bumped when a session-list arrived while a session was already shown (stream reconnected, hub restarted): every
   * buffer was emptied because the server replays all events after the list. The visualizer drops its cached
   * snapshots and rebuilds the shown session from the replay, so nothing is drawn twice.
   */
  replayRevision: number
}

/**
 * Connects the VS Code bridge to the React app.
 * When running standalone, returns useMockData=true and no events.
 * When inside VS Code, receives events and forwards control commands.
 *
 * Supports multi-session: events are buffered per-session so switching
 * sessions replays the correct event history.
 */
export function useVSCodeBridge(): BridgeHookResult {
  const [isVSCode, setIsVSCode] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [useMockData, setUseMockData] = useState(
    process.env.NEXT_PUBLIC_DEMO !== '0'
  )
  const [disable1MContext, setDisable1MContext] = useState(false)
  const pendingEventsRef = useRef<SimulationEvent[]>([])
  const [, setEventVersion] = useState(0) // trigger re-render on new events

  // Session state
  const [sessions, setSessionsState] = useState<SessionInfo[]>([])
  /** The list as last set, synchronously: the session handlers decide the selection from it (no side effects
   *  inside a React state updater). Every change goes through setSessions below. */
  const sessionsRef = useRef<SessionInfo[]>([])
  const setSessions = useCallback((next: SessionInfo[] | ((prev: SessionInfo[]) => SessionInfo[])) => {
    const value = typeof next === 'function' ? next(sessionsRef.current) : next
    if (value === sessionsRef.current) return
    sessionsRef.current = value
    setSessionsState(value)
  }, [])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const selectedSessionIdRef = useRef<string | null>(null)
  const sessionEventsRef = useRef<Map<string, SimulationEvent[]>>(new Map())
  /** True while a session switch is pending (between auto-select and useLayoutEffect).
   *  Prevents the animation frame from processing events in the wrong simulation context. */
  const sessionSwitchPendingRef = useRef(false)
  const [sessionsWithActivity, setSessionsWithActivity] = useState<Set<string>>(new Set())
  const [offboardRevision, setOffboardRevision] = useState<OffboardRevision | null>(null)
  const [replayRevision, setReplayRevision] = useState(0)
  /** Every session id this page has seen (list or started). A session-started for one of them is a replay or a
   *  resume, never a reason to move the view (spec 0.9.8 item 8). Cleared only by a reset. */
  const knownSessionIdsRef = useRef<Set<string>>(new Set())

  const applyOffboarded = useCallback((sessionId: string, agents: string[]) => {
    if (agents.length === 0) return
    const buf = sessionEventsRef.current.get(sessionId)
    if (buf) {
      const kept = dropOffboardedEvents(buf, agents)
      if (kept !== buf) sessionEventsRef.current.set(sessionId, kept)
    }
    // Rebuild even when the buffer had nothing left to drop: the node may still be drawn from earlier events
    setOffboardRevision(prev => ({ sessionId, seq: (prev?.seq ?? 0) + 1 }))
    // The team panel's "Selesai kontrak" list refreshes on this
    try {
      window.dispatchEvent(new CustomEvent(OFFBOARDED_EVENT, { detail: { sessionId, agents } }))
    } catch { /* old browsers: the list refreshes on the next load */ }
  }, [])

  // Connect to standalone dev relay server via SSE when not in VS Code
  useEffect(() => {
    if (typeof window === 'undefined') return
    const bridge = vscodeBridge
    if (!bridge) return

    // Skip in VS Code — extension handles events via postMessage
    if (bridge.isVSCode) return

    // Connect to relay in dev mode or standalone CLI mode
    const isStandalone = process.env.AGENT_FLOW_STANDALONE === '1'
    if (!isStandalone && (process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_DEMO !== '0')) return

    const relayPort = process.env.NEXT_PUBLIC_RELAY_PORT || ''
    const es = new EventSource(relayPort ? `http://127.0.0.1:${relayPort}/events` : '/events')

    es.onopen = () => {
      setConnectionStatus('connected')
      setUseMockData(false)
    }
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        window.postMessage(data, '*')
      } catch {}
    }
    es.onerror = () => {
      setConnectionStatus('disconnected')
    }

    return () => {
      es.close()
    }
  }, [])

  useEffect(() => {
    const bridge = vscodeBridge
    if (!bridge) { return }

    // Listen for bridge initialization (event-driven, no polling)
    const unsubInit = bridge.onInit(() => {
      setIsVSCode(true)
      setUseMockData(false)
    })

    // Listen for events — buffer by session, deliver to pending if session matches.
    // selectedSessionIdRef is updated synchronously (not via React state) so it's
    // always current even before React re-renders.
    const unsubEvent = bridge.onEvent((event: AgentEvent) => {
      const simEvent: SimulationEvent = {
        time: event.time,
        type: event.type as SimulationEvent['type'],
        payload: event.payload,
        sessionId: event.sessionId,
      }

      // Always buffer by session (for replay on session switch)
      if (event.sessionId) {
        const buf = sessionEventsRef.current.get(event.sessionId) || []
        buf.push(simEvent)
        sessionEventsRef.current.set(event.sessionId, buf)
        // Keep lastActivityTime roughly current (throttled: one state update per 5s per session; not for a stale
        // cloud session, whose events are a replay: lib/session-list.ts)
        const now = Date.now()
        const sid = event.sessionId
        setSessions(prev => touchActivity(prev, sid, now))
      }

      // Deliver to pending if session matches (ref is always current).
      // Skip if a session switch is pending — useLayoutEffect will flush
      // from the session buffer once the simulation state is swapped.
      const selected = selectedSessionIdRef.current
      if (selected && event.sessionId === selected && !sessionSwitchPendingRef.current) {
        pendingEventsRef.current.push(simEvent)
        setEventVersion(v => v + 1)
      } else if (event.sessionId && event.sessionId !== selected) {
        // Track background activity for unselected sessions
        setSessionsWithActivity(prev => {
          if (prev.has(event.sessionId!)) return prev
          const next = new Set(prev)
          next.add(event.sessionId!)
          return next
        })
      }

      // Re-add dismissed sessions when new events arrive
      if (event.sessionId && dismissedSessionsRef.current.has(event.sessionId)) {
        const saved = dismissedSessionsRef.current.get(event.sessionId)
        dismissedSessionsRef.current.delete(event.sessionId)
        if (saved) {
          setSessions(prev => {
            if (prev.find(s => s.id === saved.id)) return prev
            return [...prev, { ...saved, status: 'active' as const, lastActivityTime: Date.now() }]
          })
        }
      }
    })

    const unsubStatus = bridge.onStatus((status) => {
      setConnectionStatus(status)
    })

    const unsubConfig = bridge.onConfig((config) => {
      if (config.showMockData !== undefined) { setUseMockData(config.showMockData) }
      if (config.disable1MContext !== undefined) { setDisable1MContext(config.disable1MContext) }
    })

    // Session lifecycle tracking
    // Note: these handlers only update session list + selection state.
    // Event flushing is handled by the consumer (index.tsx effect) to avoid
    // races between auto-flush here and save/restore logic there.
    const unsubSession = bridge.onSession((type, data) => {
      if (type === 'reset') {
        // Panel was reopened — clear all stale state
        setSessions([])
        setSelectedSessionId(null)
        selectedSessionIdRef.current = null
        pendingEventsRef.current.length = 0
        sessionEventsRef.current.clear()
        setSessionsWithActivity(new Set())
        dismissedSessionsRef.current.clear()
        knownSessionIdsRef.current.clear()
        setEventVersion(v => v + 1)
        return
      }
      if (type === 'list') {
        const sessionList = dedupeSessions(Array.isArray(data) ? (data as SessionInfo[]) : [])
        setSessions(sessionList)
        for (const s of sessionList) knownSessionIdsRef.current.add(s.id)
        if (selectedSessionIdRef.current) {
          // A list while a session is shown: the stream reconnected (hub restart). The server replays every
          // session's events right after it, so drop the buffers instead of appending the replay to them (nothing
          // drawn twice) and let the visualizer rebuild the shown session from the replay. The selection stays
          // (spec 0.9.8 AC6: the view does not jump).
          sessionEventsRef.current.clear()
          pendingEventsRef.current.length = 0
          sessionSwitchPendingRef.current = true
          setReplayRevision(v => v + 1)
          return
        }
        // Auto-select: the most recent active session, live before stale; never one stale for 10 minutes
        // (lib/session-list.ts initialSelection).
        // Only set selection — useLayoutEffect handles flushing events.
        const autoId = initialSelection(sessionList, Date.now())
        if (autoId) {
          sessionSwitchPendingRef.current = true
          pendingEventsRef.current.length = 0
          selectedSessionIdRef.current = autoId
          setSelectedSessionId(autoId)
        }
      } else if (type === 'started') {
        const session = data as SessionInfo
        if (!session || typeof session.id !== 'string') return
        // A replay (hub restart, 409 epoch) or a stale session never moves the view, and a known id is updated in
        // place, never doubled (spec 0.9.8 item 8). Re-arming the switch for the already-selected id would set
        // sessionSwitchPendingRef without anything ever clearing it (the layout effect only runs when the
        // selection changes), freezing event delivery: applySessionStarted never selects it.
        const result = applySessionStarted(sessionsRef.current, session, {
          selectedId: selectedSessionIdRef.current,
          known: knownSessionIdsRef.current,
          now: Date.now(),
        })
        knownSessionIdsRef.current.add(session.id)
        setSessions(result.sessions)
        if (!result.select) return
        // Auto-select newly started session.
        // Set switch-pending flag to prevent the animation frame from processing
        // events in the wrong simulation state before useLayoutEffect swaps it.
        sessionSwitchPendingRef.current = true
        pendingEventsRef.current.length = 0
        selectedSessionIdRef.current = session.id
        setSelectedSessionId(session.id)
      } else if (type === 'removed') {
        // Hub retired or evicted a cloud session (spec 0.9.8 item 6): it leaves the list and its buffer; the view
        // moves to the most recent active session, or to no selection (the empty state).
        const sessionId = data as string
        const result = applySessionRemoved(sessionsRef.current, sessionId, selectedSessionIdRef.current, Date.now())
        setSessions(result.sessions)
        sessionEventsRef.current.delete(sessionId)
        dismissedSessionsRef.current.delete(sessionId)
        setSessionsWithActivity(prev => {
          if (!prev.has(sessionId)) return prev
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })
        if (!result.selectionChanged) return
        pendingEventsRef.current.length = 0
        // With no next session nothing is flushed, so nothing would clear the pending flag: only set it for a switch
        sessionSwitchPendingRef.current = result.selectedId !== null
        selectedSessionIdRef.current = result.selectedId
        setSelectedSessionId(result.selectedId)
      } else if (type === 'updated') {
        const update = data as SessionUpdate
        const { sessionId, label, projectId, prompt, coordinator } = update
        setSessions(prev => prev.map(s =>
          s.id === sessionId
            ? withCloudUpdate({
                ...s, label,
                ...(projectId !== undefined ? { projectId } : {}),
                ...(prompt !== undefined ? { prompt } : {}),
                ...(coordinator !== undefined ? { coordinator } : {}),
              }, update)
            : s
        ))
      } else if (type === 'ended') {
        const sessionId = data as string
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, status: 'completed' as const } : s
        ))
      }
    })

    const unsubOffboarded = bridge.onOffboarded(applyOffboarded)

    return () => {
      unsubInit()
      unsubEvent()
      unsubStatus()
      unsubConfig()
      unsubSession()
      unsubOffboarded()
    }
  }, [applyOffboarded, setSessions])

  const consumeEvents = useCallback(() => {
    // Clear in-place so stale closures in animation callbacks
    // also see the cleared array (prevents multi-frame reprocessing)
    pendingEventsRef.current.length = 0
  }, [])

  /** Switch session selection. Does NOT flush events — call flushSessionEvents
   *  from useLayoutEffect after the simulation state has been saved/swapped. */
  const selectSession = useCallback((sessionId: string | null) => {
    // Block event delivery to pending until the simulation state is swapped
    sessionSwitchPendingRef.current = true
    pendingEventsRef.current.length = 0
    selectedSessionIdRef.current = sessionId
    setSelectedSessionId(sessionId)
    if (sessionId) {
      setSessionsWithActivity(prev => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }, [])

  /** Flush buffered events for the selected session into pending.
   *  Must be called from useLayoutEffect AFTER simulation state is saved/swapped. */
  const flushSessionEvents = useCallback((sessionId: string, fromIndex = 0) => {
    sessionSwitchPendingRef.current = false
    const buffered = sessionEventsRef.current.get(sessionId) || []
    pendingEventsRef.current.length = 0
    pendingEventsRef.current.push(...buffered.slice(fromIndex))
    setEventVersion(v => v + 1)
  }, [])

  const getSessionEventCount = useCallback((sessionId: string): number => {
    return sessionEventsRef.current.get(sessionId)?.length ?? 0
  }, [])

  const dismissedSessionsRef = useRef<Map<string, SessionInfo>>(new Map())

  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const session = prev.find(s => s.id === sessionId)
      if (session) { dismissedSessionsRef.current.set(sessionId, session) }
      return prev.filter(s => s.id !== sessionId)
    })
    setSessionsWithActivity(prev => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [setSessions])

  const bridgeOpenFile = useCallback((filePath: string, line?: number) => {
    vscodeBridge?.openFile(filePath, line)
  }, [])

  return {
    isVSCode,
    connectionStatus,
    pendingEvents: pendingEventsRef.current,
    consumeEvents,
    useMockData,
    disable1MContext,
    bridgeOpenFile,
    sessions,
    selectedSessionId,
    selectedSessionIdRef,
    selectSession,
    flushSessionEvents,
    getSessionEventCount,
    sessionsWithActivity,
    removeSession,
    offboardRevision,
    applyOffboarded,
    replayRevision,
  }
}
