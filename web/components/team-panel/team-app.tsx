"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatSectionHandle } from './chat-section'
import { AgentVisualizer } from '@/components/agent-visualizer'
import { applyGraphTheme } from '@/lib/colors'
import { graphPaneVisible } from '@/lib/frame-rate'
import { isPanelToggleKey, PANEL_HIDDEN_KEY, parsePanelHidden, storePanelHidden } from '@/lib/team/sections'
import { nextThemePref, parseThemePref, resolveTheme, type ThemePref } from '@/lib/team/session'
import { readStored, writeStored } from './storage'
import { TeamPanel } from './team-panel'
import { useTeamModel } from './use-team-model'
import { useTeamSounds } from './use-team-sounds'
import './team-panel.css'

type Pane = 'tim' | 'grafik'

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
 * Standalone app shell: team panel next to the agent graph.
 * >= 1024px: panel column on the left, graph fills the rest.
 * Below: one pane at a time, switched with the bottom bar. Both stay mounted so the graph keeps its state.
 */
export function TeamApp() {
  const model = useTeamModel()
  useTeamSounds(model.selectedId, model.state, model.chat)
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

  // Phone and tablet: a floating "Pesan ke Sora" button on the team pane jumps to the chat and focuses the box,
  // hidden while the chat is already on screen. Desktop shows the panel column all the time: no floating button.
  const chatRef = useRef<ChatSectionHandle>(null)
  const [chatInView, setChatInView] = useState(false)
  const chatShown = model.hasPayload && (model.view === 'ready' || model.view === 'no-data')
  useEffect(() => {
    setChatInView(false)
    if (!chatShown || pane !== 'tim' || typeof IntersectionObserver === 'undefined') return
    const el = document.getElementById('chat')
    if (!el) return
    const io = new IntersectionObserver((entries) => setChatInView(entries.some((e) => e.isIntersecting)), { threshold: 0.15 })
    io.observe(el)
    return () => io.disconnect()
  }, [chatShown, pane, model.view])
  const openChat = useCallback(() => {
    setPane('tim')
    // after the pane switch is painted
    requestAnimationFrame(() => chatRef.current?.focus())
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

  return (
    <div className="tm-root tm-app" data-tm-theme={resolved} data-panel-hidden={panelHidden}>
      <div className="tm-panes">
        <main className="tm-pane tm-pane-team tm-themed" id="tm-panel-tim" data-active={pane === 'tim'} aria-label="Tim">
          <TeamPanel
            model={model}
            theme={theme}
            onCycleTheme={cycleTheme}
            chatRef={chatRef}
            onHide={() => togglePanel(true)}
          />
        </main>
        <section className="tm-pane tm-pane-graph" id="tm-panel-grafik" data-active={pane === 'grafik'} aria-label="Grafik">
          <AgentVisualizer projectId={model.selectedId} active={graphOnScreen} />
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
      </div>
      {/* Team pane only: on the graph pane it would cover the graph's own floating cards (play bar, agent chat) */}
      {chatShown && pane === 'tim' && !chatInView && (
        <div className="tm-fab-wrap tm-themed">
          <button type="button" className="tm-fab" onClick={openChat}>
            Pesan ke {model.coordinatorName}
          </button>
        </div>
      )}
      {/* Two plain toggle buttons (not a half-finished tab pattern): Tab/Enter/Space work natively */}
      <nav className="tm-nav tm-themed" aria-label="Tampilan">
        <button type="button" aria-pressed={pane === 'tim'} aria-controls="tm-panel-tim" onClick={() => setPane('tim')}>
          Tim
          {open > 0 && (
            <>
              <span className="count" aria-hidden="true">
                {open}
              </span>
              <span className="sr-only">, {open} keputusan butuh kamu</span>
            </>
          )}
        </button>
        <button
          type="button"
          aria-pressed={pane === 'grafik'}
          aria-controls="tm-panel-grafik"
          onClick={() => setPane('grafik')}
        >
          Grafik
        </button>
      </nav>
    </div>
  )
}
