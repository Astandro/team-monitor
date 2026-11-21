"use client"

import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from "react"
import { useAgentSimulation } from "@/hooks/use-agent-simulation"
import { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import { useSelectionState } from "@/hooks/use-selection-state"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { AgentCanvas } from "./canvas"
import { ControlBar } from "./control-bar"
import { RecenterButton } from "./recenter-button"
import { AgentSheet } from "./agent-sheet"
import { isSheetLayout } from "@/lib/sheet-layout"
import { AgentDetailCard } from "./agent-detail-card"
import { GlassContextMenu } from "./glass-context-menu"
import { ToolDetailPopup } from "./tool-detail-popup"
import { DiscoveryDetailPopup } from "./discovery-detail-popup"
import { FileAttentionPanel } from "./file-attention-panel"
import { TimelinePanel } from "./timeline-panel"
import { AgentChatPanel } from "./chat-panel"
import { SessionTranscriptPanel } from "./session-transcript-panel"
import { OpenFileProvider } from "./tool-content-renderer"
import { stopPropagationHandlers } from "./shared-ui"
import { TimelineEvent, TIMING } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"

import { MOCK_DURATION } from "@/lib/mock-scenario"
import { MessageFeedPanel } from "./message-feed-panel"
import { TopBar, type TopBarLayout } from "./top-bar"
import { setCostPanelTop } from "./canvas/draw-cost"
import { useAudioEffects } from "@/hooks/use-audio-effects"
import { useGraphTheme } from "@/hooks/use-graph-theme"
import { sessionsForProject, sessionToShow } from "@/lib/session-filter"
import { listSessions } from "@/lib/session-list"
import { agentIdentity, identityLine, parseCoordinator } from "@/lib/agent-identity"
import { canOffboard, finishedSubAgents, offboardAgent, offboardAllFinished, type OffboardResult } from "@/lib/team/offboard"
import type { PostFetch } from "@/lib/team/post"
import { setCanvasCoordinator } from "./canvas/identity"
import { setCanvasOwnerNodes } from "./canvas/owner-state"
import { ownerAsksKey, ownerNodeIds, type OwnerAsk } from "@/lib/owner-decision"

const postFetch: PostFetch = (url, init) => fetch(url, init)
const NO_ASKS: readonly OwnerAsk[] = []

export function AgentVisualizer({ projectId = null, active = true, ownerAsks = NO_ASKS }: {
  /** Team project chosen in the panel's switcher: only its sessions are shown (sessions without a project stay). */
  projectId?: string | null
  /** The graph is on screen (false behind the phone's Tim tab): the canvas stops drawing while it is not. */
  active?: boolean
  /** Open owner decisions of the project's state.json (lib/owner-decision.ts openOwnerAsks). */
  ownerAsks?: readonly OwnerAsk[]
} = {}) {
  const bridge = useVSCodeBridge()
  // Re-render the chrome (inline styles read COLORS) when the page theme switches
  useGraphTheme()

  const visibleSessions = useMemo(() => sessionsForProject(bridge.sessions, projectId), [bridge.sessions, projectId])
  const { selectedSessionId, selectSession } = bridge
  // History (completed, or a cloud session stale for 10 minutes) is hidden unless "Tampilkan riwayat" is on; the
  // selected session always stays listed (lib/session-list.ts). The clock only ticks while a stale session is listed.
  const [showHistory, setShowHistory] = useState(false)
  const [listNow, setListNow] = useState(() => Date.now())
  const anyStale = visibleSessions.some(s => s.stale === true)
  useEffect(() => {
    if (!anyStale) return
    setListNow(Date.now())
    const t = setInterval(() => setListNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [anyStale])
  const { listed: listedSessions, historyCount: allHistory, hiddenCount } = useMemo(
    () => listSessions(visibleSessions, { showHistory, now: listNow, selectedId: selectedSessionId }),
    [visibleSessions, showHistory, listNow, selectedSessionId],
  )
  // The toggle counts what it would reveal (hidden ones) while off, and what it would hide while on
  const historyCount = showHistory ? allHistory : hiddenCount
  const toggleHistory = useCallback(() => setShowHistory(v => !v), [])
  // Keep the shown session inside the chosen project: switch to its most recent listed one when needed
  useEffect(() => {
    const next = sessionToShow(listedSessions, selectedSessionId)
    if (next && next !== selectedSessionId) selectSession(next)
  }, [listedSessions, selectedSessionId, selectSession])

  const {
    frameRef,
    agents,
    toolCalls,
    particles,
    edges,
    discoveries,
    fileAttention,
    timelineEntries,
    currentTime,
    isPlaying,
    speed,
    maxTimeReached,
    conversations,
    play,
    pause,
    restart,
    setSpeed,
    seekToTime,
    updateAgentPosition,
    saveSnapshot,
    restoreSnapshot,
  } = useAgentSimulation({
    useMockData: bridge.useMockData,
    externalEvents: bridge.pendingEvents,
    onExternalEventsConsumed: bridge.consumeEvents,
    sessionFilter: bridge.selectedSessionId,
    // Pass the ref that's updated synchronously in session-started handler,
    // so the animation frame never uses a stale filter value.
    sessionFilterRef: bridge.selectedSessionIdRef,
    disable1MContext: bridge.disable1MContext,
  })

  const selection = useSelectionState({ agents, toolCalls, discoveries })

  const [showStats, setShowStats] = useState(false)
  const [showHexGrid, setShowHexGrid] = useState(true)
  const [showCostOverlay, setShowCostOverlay] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const [showFileAttention, setShowFileAttention] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)

  // Mutually exclusive panel toggling — opening one closes the others
  const toggleExclusivePanel = useCallback((panel: 'files' | 'transcript' | 'cost') => {
    setShowFileAttention(prev => panel === 'files' ? !prev : false)
    setShowTranscript(prev => panel === 'transcript' ? !prev : false)
    setShowCostOverlay(prev => panel === 'cost' ? !prev : false)
  }, [])
  const [zoomToFitTrigger, setZoomToFitTrigger] = useState(0)

  // The selected session's coordinator names the main node (prefer the session's over the spawn payload)
  const coordinator = useMemo(
    () => parseCoordinator(bridge.sessions.find(s => s.id === bridge.selectedSessionId)?.coordinator),
    [bridge.sessions, bridge.selectedSessionId],
  )
  useLayoutEffect(() => setCanvasCoordinator(coordinator), [coordinator])

  // "Butuh jawaban owner": the asking agent's node (else the coordinator's) while a decision is open
  const asksKey = ownerAsksKey(ownerAsks)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the asks' content, not the array identity
  const asks = useMemo(() => ownerAsks, [asksKey])
  const ownerNodes = useMemo(() => ownerNodeIds(agents.values(), asks, coordinator), [agents, asks, coordinator])
  useLayoutEffect(() => setCanvasOwnerNodes(ownerNodes), [ownerNodes])
  useEffect(() => () => setCanvasOwnerNodes(new Set()), [])

  const [isReviewing, setIsReviewing] = useState(false)
  const { seekingRef, handleToggleMute } = useAudioEffects({
    agents, toolCalls, particles, isReviewing,
    sessionKey: bridge.selectedSessionId,
    sessions: bridge.sessions,
    ownerNodes,
    ownerOpen: asks.length > 0,
  })

  // Auto-play on mount
  useEffect(() => {
    const timer = setTimeout(() => play(), TIMING.autoPlayDelayMs)
    return () => clearTimeout(timer)
  }, [play])

  // Per-session state cache: save/restore simulation state on tab switch
  // so sessions stay up to date and switching is instant.
  // useLayoutEffect ensures restart happens synchronously before any animation
  // frame can consume and discard events from pendingEventsRef.
  const sessionCacheRef = useRef<Map<string, { snapshot: ReturnType<typeof saveSnapshot>; eventCount: number }>>(new Map())
  const prevSelectedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (bridge.selectedSessionId === null && prevSelectedRef.current !== null) {
      // Bridge reset (panel reopened / relay restarted), or the shown session was removed with no active one left:
      // cached snapshots are stale, and the graph must not keep drawing the session that is gone (empty state)
      sessionCacheRef.current.clear()
      prevSelectedRef.current = null
      setIsReviewing(false)
      restart()
      return
    }
    if (bridge.selectedSessionId && bridge.selectedSessionId !== prevSelectedRef.current) {
      // Review/scrub state is per-component, not per-session: the incoming tab is restored live
      setIsReviewing(false)
      // Save outgoing session state (if any)
      if (prevSelectedRef.current !== null) {
        sessionCacheRef.current.set(prevSelectedRef.current, {
          snapshot: saveSnapshot(),
          eventCount: bridge.getSessionEventCount(prevSelectedRef.current),
        })
      }

      // Restore or cold-start the incoming session, then flush events.
      // Flushing happens HERE (after state swap) to prevent the animation
      // frame from processing events in the wrong simulation context.
      const cached = sessionCacheRef.current.get(bridge.selectedSessionId)
      if (cached) {
        restoreSnapshot(cached.snapshot)
        bridge.flushSessionEvents(bridge.selectedSessionId, cached.eventCount)
      } else {
        restart()
        bridge.flushSessionEvents(bridge.selectedSessionId)
      }

      prevSelectedRef.current = bridge.selectedSessionId
    }
  }, [bridge.selectedSessionId, restart, bridge.flushSessionEvents, saveSnapshot, restoreSnapshot, bridge.getSessionEventCount])

  // Offboarded agents (D22): their events are already out of the session buffer; rebuild the shown session
  // from it (same as a cold start), and forget the cached snapshot of any other session it touched.
  const offboardRevision = bridge.offboardRevision
  useLayoutEffect(() => {
    if (!offboardRevision) return
    const sid = offboardRevision.sessionId
    sessionCacheRef.current.delete(sid)
    if (sid !== bridge.selectedSessionId) return
    selection.clearAgent()
    setIsReviewing(false)
    restart()
    bridge.flushSessionEvents(sid)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per revision only
  }, [offboardRevision])

  // A session-list arrived while a session was shown (stream reconnected, hub restarted): the bridge emptied every
  // buffer and the server is replaying them. Snapshots point into the old buffers, so they go; the shown session is
  // rebuilt from the replay (same as a cold start), keeping one node per agent and one coordinator (AC5, AC6).
  const replayRevision = bridge.replayRevision
  useLayoutEffect(() => {
    if (replayRevision === 0) return
    sessionCacheRef.current.clear()
    const sid = bridge.selectedSessionId
    if (!sid) return
    setIsReviewing(false)
    restart()
    bridge.flushSessionEvents(sid)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per revision only
  }, [replayRevision])

  // A session the bridge dropped (session-removed, or closed) must not come back from a stale snapshot
  useEffect(() => {
    const ids = new Set(bridge.sessions.map(s => s.id))
    for (const id of [...sessionCacheRef.current.keys()]) if (!ids.has(id)) sessionCacheRef.current.delete(id)
  }, [bridge.sessions])

  // Offboarding works in the standalone app (it has the endpoints), on live data, with a session shown
  const offboardSession = !bridge.isVSCode && !bridge.useMockData ? bridge.selectedSessionId : null
  const { applyOffboarded } = bridge
  const runOffboard = useCallback(async (agentId: string | null): Promise<OffboardResult> => {
    if (!offboardSession) return { ok: false, kind: 'error', status: 0, message: 'Belum ada sesi yang dipilih.' }
    const r = agentId === null
      ? await offboardAllFinished(postFetch, offboardSession)
      : await offboardAgent(postFetch, offboardSession, agentId)
    if (r.ok) applyOffboarded(offboardSession, r.agents.length > 0 ? r.agents : agentId ? [agentId] : [])
    else if (r.kind === 'login') window.location.assign('/login')
    return r
  }, [offboardSession, applyOffboarded])
  const [menuOffboardError, setMenuOffboardError] = useState('')
  useEffect(() => setMenuOffboardError(''), [offboardSession])
  const handleOffboardAll = useCallback(() => runOffboard(null), [runOffboard])

  // Timeline events — incremental: only processes new conversation messages
  const timelineCacheRef = useRef<{
    counts: Map<string, number>
    events: TimelineEvent[]
    idCounter: number
  }>({ counts: new Map(), events: [], idCounter: 0 })

  const timelineEvents = useMemo((): TimelineEvent[] => {
    const cache = timelineCacheRef.current
    let appended = false
    for (const [agentId, msgs] of conversations) {
      const prevLen = cache.counts.get(agentId) ?? 0
      if (msgs.length > prevLen) {
        for (let i = prevLen; i < msgs.length; i++) {
          const msg = msgs[i]
          cache.events.push({
            id: `event-${cache.idCounter++}`,
            type: msg.type === 'tool_call' ? 'tool_call' : msg.type === 'tool_result' ? 'tool_result' : 'message',
            label: msg.content.slice(0, 20),
            timestamp: msg.timestamp,
            nodeId: agentId,
          })
        }
        cache.counts.set(agentId, msgs.length)
        appended = true
      }
    }
    if (appended) cache.events.sort((a, b) => a.timestamp - b.timestamp)
    return cache.events
  }, [conversations])

  // Review mode: when in live mode and user pauses to scrub through history

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pause()
      setIsReviewing(true)
    } else {
      play()
    }
  }, [isPlaying, play, pause])

  const handleEnterReview = useCallback(() => {
    pause()
    setIsReviewing(true)
  }, [pause])

  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleResumeLive = useCallback(() => {
    setIsReviewing(false)
    seekToTime(maxTimeReached)
    setZoomToFitTrigger(n => n + 1)
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
    resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; play() }, TIMING.resumeLiveDelayMs)
  }, [seekToTime, maxTimeReached, play])
  useEffect(() => () => { if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current) }, [])

  const handleRestart = useCallback(() => {
    setIsReviewing(false)
    restart(true)
  }, [restart])

  // Keyboard shortcuts
  const keyboardActions = useMemo(() => ({
    togglePlayPause: handlePlayPause,
    toggleFilePanel: () => toggleExclusivePanel('files'),
    toggleTranscript: () => toggleExclusivePanel('transcript'),
    toggleTimeline: () => { setShowTimeline(prev => !prev) },
    toggleHexGrid: () => { setShowHexGrid(prev => !prev) },
    toggleStats: () => { setShowStats(prev => !prev) },
    toggleCostOverlay: () => toggleExclusivePanel('cost'),
    zoomToFit: () => { setZoomToFitTrigger(n => n + 1) },
    clearSelection: () => { selection.clearAllSelections() },
    deselectAgent: () => { selection.clearAgent() },
    closeTranscript: () => { setShowTranscript(false) },
    toggleMute: handleToggleMute,
    setSpeed,
    selectedAgentId: selection.selectedAgentId,
  }), [handlePlayPause, selection.clearAllSelections, selection.clearAgent, selection.selectedAgentId, setSpeed, handleToggleMute, toggleExclusivePanel])

  useKeyboardShortcuts(keyboardActions)

  const totalTokens = useMemo(() => {
    let sum = 0
    for (const a of agents.values()) sum += a.tokensUsed
    return sum
  }, [agents])

  const selectedAgent = selection.selectedAgentId ? agents.get(selection.selectedAgentId) : null
  const selectedConversation = selection.selectedAgentId ? (conversations.get(selection.selectedAgentId) || []) : []

  // Session runtime — drives the assistant label (CLAUDE vs CODEX) in transcript panels
  const sessionRuntime = useMemo(() => {
    for (const a of agents.values()) {
      if (a.runtime === 'codex') return 'codex' as const
    }
    return 'claude' as const
  }, [agents])

  // Session-wide conversation (all agents merged chronologically)
  // Only compute when the transcript panel is visible to avoid O(n log n) sort every frame
  const sessionConversation = useMemo(() => {
    if (!showTranscript) return []
    const all = Array.from(conversations.values()).flat()
    return all.sort((a, b) => a.timestamp - b.timestamp)
  }, [conversations, showTranscript])

  // The top bar can wrap onto several rows. Floating panels (file list, cost) sit under it;
  // on narrow screens they also clear the message card, which is as wide as the screen.
  const [panelTop, setPanelTop] = useState(48)
  // Auto-fit frames the graph below the controls (owner feedback 13 Nov): below the bars on a wide graph, below
  // the one control row on a phone. The message card is not counted; opened, it floats over the graph.
  const [fitTop, setFitTop] = useState(0)
  const [graphCompact, setGraphCompact] = useState(false)
  const handleTopLayout = useCallback((l: TopBarLayout) => {
    const narrow = l.width < 720
    const top = Math.max(48, Math.ceil((narrow ? l.stackBottom : l.barsBottom) + 8))
    setCostPanelTop(top)
    setPanelTop(top)
    setFitTop(Math.ceil(l.barsBottom + 8))
    setGraphCompact(l.compact)
  }, [])

  const finishedCount = useMemo(() => finishedSubAgents(agents).length, [agents])

  // Phone and tablet widths show agent details in one bottom sheet (web/lib/sheet-layout.ts)
  const [sheetLayout, setSheetLayout] = useState(() => typeof window !== 'undefined' && isSheetLayout(window.innerWidth))
  useEffect(() => {
    const on = () => setSheetLayout(isSheetLayout(window.innerWidth))
    on()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  // Context menu items (right click / long press on a node)
  const menuAgentId = selection.contextMenu?.agentId ?? null
  const menuAgent = menuAgentId ? agents.get(menuAgentId) : undefined
  const contextMenuItems = selection.contextMenu ? (
    menuAgentId ? [
      { label: 'Tampilkan atau sembunyikan statistik', onClick: () => setShowStats(prev => !prev) },
      ...(offboardSession && canOffboard(menuAgent) ? [
        { label: '', onClick: () => {}, separator: true },
        {
          label: 'Offboard',
          onClick: () => {
            setMenuOffboardError('')
            void runOffboard(menuAgentId).then(r => { if (!r.ok) setMenuOffboardError(r.message) })
          },
        },
      ] : []),
    ] : [
      { label: 'Pas-kan ke layar', onClick: () => setZoomToFitTrigger(n => n + 1) },
      { label: 'Tampilkan atau sembunyikan statistik', onClick: () => setShowStats(prev => !prev) },
      { label: 'Tampilkan atau sembunyikan kisi', onClick: () => setShowHexGrid(prev => !prev) },
      { label: '', onClick: () => {}, separator: true },
      { label: 'Ulangi dari awal', onClick: restart },
    ]
  ) : []

  const handleCloseSession = useCallback((id: string) => {
    bridge.removeSession(id)
    sessionCacheRef.current.delete(id)
    if (bridge.selectedSessionId === id) {
      const remaining = bridge.sessions.filter(s => s.id !== id)
      if (remaining.length > 0) {
        bridge.selectSession(remaining[remaining.length - 1].id)
      }
    }
  }, [bridge])

  const openFile = useCallback((filePath: string, line?: number) => {
    bridge.bridgeOpenFile(filePath, line)
  }, [bridge])

  const isEmpty = agents.size === 0 && !bridge.useMockData

  return (
    <OpenFileProvider value={bridge.isVSCode ? openFile : null}>
    <div className="h-screen w-screen relative overflow-hidden" style={{ background: COLORS.void }}>
      {/* Empty state when no demo and no live data */}
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-center px-4">
            <div className="text-base font-semibold" style={{ color: COLORS.textPrimary }}>Menunggu sesi agent</div>
            <div className="mt-2 text-sm" style={{ color: COLORS.textMuted }}>Mulai sesi Claude Code, aktivitasnya akan muncul di sini.</div>
          </div>
        </div>
      )}

      {/* Canvas fills everything */}
      <AgentCanvas
        simulationRef={frameRef}
        selectedAgentId={selection.selectedAgentId}
        hoveredAgentId={selection.hoveredAgentId}
        showStats={showStats}
        showHexGrid={showHexGrid}
        zoomToFitTrigger={zoomToFitTrigger}
        pauseAutoFit={selection.contextMenu !== null}
        fitTop={fitTop}
        onAgentClick={selection.handleAgentClick}
        onAgentHover={selection.setHoveredAgentId}
        onAgentDrag={updateAgentPosition}
        onContextMenu={selection.handleContextMenu}
        onToolCallClick={selection.handleToolCallClick}
        selectedToolCallId={selection.selectedToolCallId}
        onDiscoveryClick={selection.handleDiscoveryClick}
        selectedDiscoveryId={selection.selectedDiscoveryId}
        showCostOverlay={showCostOverlay}
        active={active}
      />

      {/* Phones and tablets: one bottom sheet (detail, transcript one tap away); desktop: floating card + chat panel */}
      {sheetLayout && selectedAgent && (
        <AgentSheet
          agent={selectedAgent}
          coordinator={coordinator}
          conversation={selectedConversation}
          runtime={selectedAgent.runtime ?? sessionRuntime}
          onOffboard={offboardSession ? runOffboard : undefined}
          onClose={selection.clearAgent}
          topReserve={fitTop}
        />
      )}

      {/* Agent detail card (floating, tethered to node) */}
      {!sheetLayout && selectedAgent && selection.selectedAgentWorldPos && (
        <div {...stopPropagationHandlers}>
          <AgentDetailCard
            agent={selectedAgent}
            coordinator={coordinator}
            onOffboard={offboardSession ? runOffboard : undefined}
            onClose={selection.clearAgent}
          />
        </div>
      )}

      {/* Tool call detail popup */}
      {selection.selectedToolData && selection.selectedToolScreenPos && (
        <div {...stopPropagationHandlers}>
          <ToolDetailPopup
            tool={selection.selectedToolData}
            position={selection.selectedToolScreenPos}
            onClose={selection.clearTool}
          />
        </div>
      )}

      {/* Discovery detail popup */}
      {selection.selectedDiscoveryData && selection.selectedDiscoveryScreenPos && (
        <div {...stopPropagationHandlers}>
          <DiscoveryDetailPopup
            discovery={selection.selectedDiscoveryData}
            position={selection.selectedDiscoveryScreenPos}
            onClose={selection.clearDiscovery}
          />
        </div>
      )}

      {/* Chat panel (bottom-right, shown when agent selected) */}
      <AgentChatPanel
        visible={!sheetLayout && !!selectedAgent}
        agentName={selectedAgent ? identityLine(agentIdentity(selectedAgent, coordinator)) : ''}
        agentState={selectedAgent?.state ?? 'idle'}
        agentIsMain={!!selectedAgent?.isMain}
        conversation={selectedConversation}
        runtime={selectedAgent?.runtime ?? sessionRuntime}
        onClose={selection.clearAgent}
      />

      {/* Context menu */}
      {selection.contextMenu && (
        <GlassContextMenu
          position={selection.contextMenu}
          items={contextMenuItems}
          onClose={() => selection.setContextMenu(null)}
        />
      )}

      {/* Re-centre: back to the Orchestrator and the sub-agents at work (drops a node focus, keeps everything else) */}
      {!isEmpty && <RecenterButton onClick={() => { selection.clearAgent(); setZoomToFitTrigger(n => n + 1) }} />}

      {/* Floating control strip */}
      <ControlBar
        isPlaying={isPlaying}
        speed={speed}
        currentTime={currentTime}
        totalDuration={bridge.useMockData
          ? (isReviewing ? Math.max(maxTimeReached, currentTime) : MOCK_DURATION)
          : Math.max(maxTimeReached, currentTime)
        }
        onPlayPause={handlePlayPause}
        onRestart={handleRestart}
        onSpeedChange={setSpeed}
        onSeek={(time) => {
          seekingRef.current = true
          pause()
          seekToTime(time)
          setZoomToFitTrigger(n => n + 1)
          if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
          resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; seekingRef.current = false }, TIMING.seekCompleteDelayMs)
        }}
        timelineEvents={timelineEvents}
        isReviewing={isReviewing}
        eventCount={timelineEvents.length}
        onEnterReview={handleEnterReview}
        onResumeLive={handleResumeLive}
      />

      {/* File attention panel (slide-in from right) */}
      <FileAttentionPanel
        visible={showFileAttention}
        fileAttention={fileAttention}
        onClose={() => setShowFileAttention(false)}
        onOpenFile={bridge.isVSCode ? openFile : undefined}
        top={panelTop}
      />

      {/* Session transcript panel (slide-in from right) */}
      <SessionTranscriptPanel
        visible={showTranscript}
        conversation={sessionConversation}
        runtime={sessionRuntime}
        onClose={() => setShowTranscript(false)}
      />

      {/* Timeline panel (slide-in from bottom) */}
      <TimelinePanel
        visible={showTimeline}
        timelineEntries={timelineEntries}
        currentTime={currentTime}
        onClose={() => setShowTimeline(false)}
      />

      {/* Top bar: session tabs + info/controls */}
      <TopBar
        sessions={listedSessions}
        historyCount={historyCount}
        showHistory={showHistory}
        onToggleHistory={toggleHistory}
        selectedSessionId={bridge.selectedSessionId}
        sessionsWithActivity={bridge.sessionsWithActivity}
        onSelectSession={bridge.selectSession}
        onCloseSession={handleCloseSession}
        isVSCode={bridge.isVSCode}
        connectionStatus={bridge.connectionStatus}
        agentCount={agents.size}
        totalTokens={totalTokens}
        showFileAttention={showFileAttention}
        showTranscript={showTranscript}
        showCostOverlay={showCostOverlay}
        showTimeline={showTimeline}
        onTogglePanel={toggleExclusivePanel}
        onToggleTimeline={() => setShowTimeline(prev => !prev)}
        finishedCount={offboardSession ? finishedCount : 0}
        onOffboardAll={handleOffboardAll}
        offboardNotice={menuOffboardError}
        onLayout={handleTopLayout}
      >
        {/* Message feed card: in flow under the bars so it never overlaps the tabs */}
        <MessageFeedPanel
          conversations={conversations}
          agents={agents}
          onAgentClick={selection.handleAgentClick}
          selectedAgentId={selection.selectedAgentId}
          compact={graphCompact}
        />
      </TopBar>
    </div>
    </OpenFileProvider>
  )
}
