"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChatSection, type ChatSectionHandle } from './chat-section'
import { AgentVisualizer } from '@/components/agent-visualizer'
import { applyGraphTheme } from '@/lib/colors'
import { graphPaneVisible } from '@/lib/frame-rate'
import {
  CHAT_HEIGHT_KEY,
  CHAT_HEIGHT_STEP,
  CHAT_MIN_HEIGHT,
  CHAT_OPEN_KEY,
  chatOnScreen,
  clampChatHeight,
  navTabs,
  paneForWidth,
  parseChatHeight,
  parseChatOpen,
  storeChatOpen,
  TAB_LABEL,
  type Pane,
} from '@/lib/team/chat-layout'
import {
  CHAT_SEEN_KEY,
  nextSeenMarks,
  parseSeenMarks,
  storeSeenMarks,
  unreadBadge,
  unreadCount,
  unreadLabel,
  type SeenMarks,
} from '@/lib/team/chat-unread'
import { isPanelToggleKey, PANEL_HIDDEN_KEY, parsePanelHidden, storePanelHidden } from '@/lib/team/sections'
import { nextThemePref, parseThemePref, resolveTheme, type ThemePref } from '@/lib/team/session'
import { openOwnerAsks } from '@/lib/owner-decision'
import { readStored, writeStored } from './storage'
import { TeamPanel } from './team-panel'
import { useTeamModel } from './use-team-model'
import { useTeamSounds } from './use-team-sounds'
import './team-panel.css'

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

/** Speech-bubble glyph for the desktop chat button (the messenger convention for "chat"). */
function ChatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
    </svg>
  )
}

/**
 * Drag handle on the top edge of the desktop chat panel: drag, or Arrow up/down (Home/End for the extremes).
 * A window splitter in ARIA terms, so it is a focusable separator with its value.
 */
function ResizeHandle({ height, max, onChange }: { height: number; max: number; onChange: (h: number) => void }) {
  const start = useRef<{ y: number; h: number } | null>(null)
  return (
    <div
      className="tm-chat-grip"
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Ubah tinggi panel chat"
      aria-controls="tm-panel-chat"
      aria-valuemin={Math.min(CHAT_MIN_HEIGHT, max)}
      aria-valuemax={max}
      aria-valuenow={height}
      title="Tarik untuk ubah tinggi"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { y: e.clientY, h: height }
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (s) onChange(s.h + (s.y - e.clientY))
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowUp' ? CHAT_HEIGHT_STEP : e.key === 'ArrowDown' ? -CHAT_HEIGHT_STEP : 0
        if (step) onChange(height + step)
        else if (e.key === 'Home') onChange(CHAT_MIN_HEIGHT)
        else if (e.key === 'End') onChange(max)
        else return
        e.preventDefault()
      }}
    >
      <span aria-hidden="true" />
    </div>
  )
}

/** Inner height of an element, kept current. */
function useHeight(ref: React.RefObject<HTMLElement | null>, on: boolean): number {
  const [h, setH] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || !on || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setH(el.clientHeight))
    ro.observe(el)
    setH(el.clientHeight)
    return () => ro.disconnect()
  }, [ref, on])
  return h
}

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

/** >= 1024 px: panel column and graph side by side, both always on screen. */
function useDesktop(): boolean {
  const [desk, setDesk] = useState(() => window.matchMedia('(min-width:1024px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width:1024px)')
    const on = (e: MediaQueryListEvent) => setDesk(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return desk
}

/**
 * Standalone app shell: team panel next to the agent graph, plus the chat with the coordinator.
 * >= 1024px: panel column on the left, graph fills the rest, the chat a column on the right while open (bubble when
 * closed). Below: one pane at a time (Tim / Grafik / Chat), switched with the bottom bar. All stay mounted so the
 * graph keeps its state and a half-typed message stays.
 */
export function TeamApp() {
  const model = useTeamModel()
  useTeamSounds(model.selectedId, model.state, model.chat)
  // open owner decisions put the asking agent's node on the graph in the "Butuh jawaban owner" state
  const ownerAsks = useMemo(() => openOwnerAsks(model.state), [model.state])
  const systemDark = useSystemDark()
  const [theme, setTheme] = useState<ThemePref>(() => parseThemePref(readStored('tm-theme')))
  const [pane, setPane] = useState<Pane>('tim')
  const desktop = useDesktop()
  // Behind the phone's Tim tab the graph stops drawing (web/lib/frame-rate.ts); its simulation keeps running.
  const graphOnScreen = graphPaneVisible(pane, desktop)

  const cycleTheme = useCallback(() => setTheme((t) => nextThemePref(t)), [])
  // remembered after the state changed, not inside the state updaters
  useEffect(() => writeStored('tm-theme', theme), [theme])
  // Motion follows prefers-reduced-motion only (no "Jeda animasi" switch any more, owner request 13 Nov)

  // ─── Chat with the coordinator (spec-chat-layout) ───
  // Phone/tablet: the third tab. Desktop: a panel docked right of the graph, opened from the bubble, remembered.
  const chatRef = useRef<ChatSectionHandle>(null)
  const chatReady = model.hasPayload && (model.view === 'ready' || model.view === 'no-data')
  const [chatOpen, setChatOpen] = useState(() => parseChatOpen(readStored(CHAT_OPEN_KEY)))
  useEffect(() => writeStored(CHAT_OPEN_KEY, storeChatOpen(chatOpen)), [chatOpen])
  const [chatHeight, setChatHeight] = useState<number | null>(() => parseChatHeight(readStored(CHAT_HEIGHT_KEY)))
  useEffect(() => {
    if (chatHeight !== null) writeStored(CHAT_HEIGHT_KEY, String(chatHeight))
  }, [chatHeight])
  // the Chat tab does not exist on desktop: a phone rotated or a window widened lands on Tim
  useEffect(() => setPane((p) => paneForWidth(p, desktop)), [desktop])
  const pageVisible = usePageVisible()
  const chatVisible = chatOnScreen({ desktop, pane, panelOpen: chatOpen, pageVisible })

  // Unread replies per project, remembered per browser; cleared while the chat is on screen.
  const [seen, setSeen] = useState<SeenMarks>(() => parseSeenMarks(readStored(CHAT_SEEN_KEY)))
  useEffect(() => {
    const next = nextSeenMarks(seen, model.selectedId, model.chat, chatVisible, new Date().toISOString())
    if (!next) return
    setSeen(next)
    writeStored(CHAT_SEEN_KEY, storeSeenMarks(next))
  }, [seen, model.selectedId, model.chat, chatVisible])
  const unread = chatVisible || !model.selectedId ? 0 : unreadCount(model.chat, seen[model.selectedId])

  // Opening from the bubble lands in the message box; closing gives focus back to the bubble.
  const chatFocus = useRef<'box' | 'bubble' | null>(null)
  useEffect(() => {
    const f = chatFocus.current
    chatFocus.current = null
    if (f === 'box') chatRef.current?.focus()
    if (f === 'bubble') document.getElementById('tm-chat-bubble')?.focus()
  }, [chatOpen])
  const setChatPanel = useCallback((open: boolean) => {
    chatFocus.current = open ? 'box' : 'bubble'
    setChatOpen(open)
  }, [])

  // Desktop: the panel can be hidden so the graph takes the full width (spec-panel-compact item 1). Remembered per
  // browser. Below 1024 px the flag does nothing: phone and tablet keep the Tim/Grafik switch.
  const [panelHidden, setPanelHidden] = useState(() => parsePanelHidden(readStored(PANEL_HIDDEN_KEY)))
  useEffect(() => writeStored(PANEL_HIDDEN_KEY, storePanelHidden(panelHidden)), [panelHidden])
  // Focus follows the control that just appeared, so a keyboard user never lands on a hidden button.
  const focusAfter = useRef<string | null>(null)
  useEffect(() => {
    const id = focusAfter.current
    focusAfter.current = null
    if (id) document.getElementById(id)?.focus()
  }, [panelHidden])
  const togglePanel = useCallback((focus: boolean) => {
    setPanelHidden((h) => {
      if (focus) focusAfter.current = h ? 'tm-panel-toggle' : 'tm-panel-show'
      return !h
    })
  }, [])
  useEffect(() => {
    const desk = window.matchMedia('(min-width:1024px)')
    const onKey = (e: KeyboardEvent) => {
      if (!desk.matches) return
      const t = e.target instanceof HTMLElement ? e.target : null
      if (!isPanelToggleKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, repeat: e.repeat, defaultPrevented: e.defaultPrevented, target: t })) return
      e.preventDefault()
      // move focus only when it was on the control that is about to disappear (or nowhere in particular)
      const active = document.activeElement
      const onToggle = !active || active === document.body || active.id === 'tm-panel-toggle' || active.id === 'tm-panel-show'
      togglePanel(onToggle || !!document.getElementById('tm-panel-tim')?.contains(active))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePanel])

  const open = model.view === 'ready' ? model.vm.openDecisions : 0
  const resolved = resolveTheme(theme, systemDark)
  // One theme switch for the whole page: the graph palette follows the panel's, before the next paint.
  useLayoutEffect(() => applyGraphTheme(resolved), [resolved])

  const name = model.coordinatorName
  const badge = unreadBadge(unread)
  const unreadText = unreadLabel(unread, name)
  const dockOpen = desktop && chatOpen
  const roomRef = useRef<HTMLDivElement>(null)
  const room = useHeight(roomRef, dockOpen)
  const panelHeight = clampChatHeight(chatHeight, room)

  // What the chat area says before there is a thread to show (R-27: loading and the no-project case).
  const chatBody = chatReady ? (
    <ChatSection
      ref={chatRef}
      thread={model.thread}
      coordinatorName={name}
      watcherNotice={model.watcherNotice}
      send={model.sendMessage}
      shown={chatVisible}
      headerAction={
        desktop ? (
          <button
            type="button"
            className="tm-icon-btn"
            aria-label="Tutup panel chat"
            title="Tutup panel chat (Esc)"
            aria-controls="tm-panel-chat"
            aria-expanded="true"
            onClick={() => setChatPanel(false)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        ) : undefined
      }
    />
  ) : (
    <div className="tm-chat-wait">
      <h2>Chat dengan {name}</h2>
      <p>
        {model.view === 'no-projects'
          ? 'Belum ada proyek yang dipantau, jadi belum ada chat.'
          : model.listError || model.stateError || 'Lagi memuat chat…'}
      </p>
    </div>
  )

  return (
    <div
      className="tm-root tm-app"
      data-tm-theme={resolved}
      data-panel-hidden={panelHidden}
      data-chat-open={dockOpen}
    >
      <div className="tm-panes">
        <main className="tm-pane tm-pane-team tm-themed" id="tm-panel-tim" data-active={pane === 'tim'} aria-label="Tim">
          <TeamPanel model={model} theme={theme} onCycleTheme={cycleTheme} onHide={() => togglePanel(true)} />
        </main>
        <section className="tm-pane tm-pane-graph" id="tm-panel-grafik" data-active={pane === 'grafik'} aria-label="Grafik">
          <AgentVisualizer projectId={model.selectedId} active={graphOnScreen} ownerAsks={ownerAsks} />
          {/* Desktop with the panel hidden: a slim tab on the left edge brings it back; it carries the open-decision
              count so a waiting decision is not missed while the panel is away. */}
          {panelHidden && (
            <div className="tm-edge tm-themed">
              <button
                type="button"
                id="tm-panel-show"
                className="tm-edge-btn"
                aria-controls="tm-panel-tim"
                aria-expanded="false"
                title="Tampilkan panel tim (tombol [)"
                aria-label={`Tampilkan panel tim${open > 0 ? `, ${open} keputusan butuh kamu` : ''}`}
                onClick={() => togglePanel(true)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <path d="M9 4v16" />
                  <path d="M14 10l2 2-2 2" />
                </svg>
                <span className="lbl">Tim</span>
                {open > 0 && (
                  <span className="count" aria-hidden="true">
                    {open}
                  </span>
                )}
              </button>
            </div>
          )}
        </section>
        {/* The chat: the third pane on a phone or tablet; on desktop a column right of the graph while open (the graph
            keeps its own area and re-fits, so nothing of it is covered), hidden while closed. One element for both, so
            a half-typed message survives a resize. */}
        <aside
          className="tm-pane tm-pane-chat tm-themed"
          id="tm-panel-chat"
          data-active={desktop ? chatOpen : pane === 'chat'}
          aria-label={`Chat dengan ${name}`}
        >
          <div className="tm-chat-room" ref={roomRef}>
            <div
              className="tm-chat-float"
              style={dockOpen && room > 0 ? { height: panelHeight } : undefined}
              onKeyDown={(e) => {
                if (!desktop || e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing) return
                e.preventDefault()
                setChatPanel(false)
              }}
            >
              {dockOpen && room > 0 && <ResizeHandle height={panelHeight} max={room} onChange={(h) => setChatHeight(clampChatHeight(h, room))} />}
              {chatBody}
            </div>
          </div>
        </aside>
        {/* Desktop, chat closed: the bubble at the bottom right, stacked above the graph's re-centre button so it
            never covers it or the play bar. The badge counts replies since the chat was last on screen. */}
        {desktop && !chatOpen && (
          <div className="tm-chat-bubble-wrap tm-themed">
            <button
              type="button"
              id="tm-chat-bubble"
              className="tm-chat-bubble"
              aria-controls="tm-panel-chat"
              aria-expanded="false"
              aria-label={`Buka chat dengan ${name}${unreadText ? `, ${unreadText}` : ''}`}
              title={`Chat dengan ${name}`}
              onClick={() => setChatPanel(true)}
            >
              <ChatIcon />
              <span className="lbl">Chat</span>
              {badge && (
                <span className="count" aria-hidden="true">
                  {badge}
                </span>
              )}
            </button>
          </div>
        )}
      </div>
      {/* Plain toggle buttons (not a half-finished tab pattern): Tab/Enter/Space work natively */}
      <nav className="tm-nav tm-themed" aria-label="Tampilan">
        {navTabs(desktop).map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={pane === p}
            aria-controls={`tm-panel-${p}`}
            onClick={() => setPane(p)}
          >
            {TAB_LABEL[p]}
            {p === 'tim' && open > 0 && (
              <>
                <span className="count" aria-hidden="true">
                  {open}
                </span>
                <span className="sr-only">, {open} keputusan butuh kamu</span>
              </>
            )}
            {p === 'chat' && badge && (
              <>
                <span className="count unread" aria-hidden="true">
                  {badge}
                </span>
                <span className="sr-only">, {unreadText}</span>
              </>
            )}
          </button>
        ))}
      </nav>
    </div>
  )
}
