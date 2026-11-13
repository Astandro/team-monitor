"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatSectionHandle } from './chat-section'
import { AgentVisualizer } from '@/components/agent-visualizer'
import { applyGraphTheme } from '@/lib/colors'
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
  const [calm, setCalm] = useState(() => readStored('tm-calm') === '1')
  const [pane, setPane] = useState<Pane>('tim')

  const cycleTheme = useCallback(() => setTheme((t) => nextThemePref(t)), [])
  const toggleCalm = useCallback(() => setCalm((c) => !c), [])
  // remembered after the state changed, not inside the state updaters
  useEffect(() => writeStored('tm-theme', theme), [theme])
  useEffect(() => writeStored('tm-calm', calm ? '1' : '0'), [calm])

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

  const open = model.view === 'ready' ? model.vm.openDecisions : 0
  const resolved = resolveTheme(theme, systemDark)
  // One theme switch for the whole page: the graph palette follows the panel's, before the next paint.
  useLayoutEffect(() => applyGraphTheme(resolved), [resolved])

  return (
    <div className={`tm-root tm-app${calm ? ' tm-calm' : ''}`} data-tm-theme={resolved}>
      <div className="tm-panes">
        <main className="tm-pane tm-pane-team tm-themed" id="tm-panel-tim" data-active={pane === 'tim'} aria-label="Tim">
          <TeamPanel
            model={model}
            theme={theme}
            onCycleTheme={cycleTheme}
            calm={calm}
            onToggleCalm={toggleCalm}
            chatRef={chatRef}
          />
        </main>
        <section className="tm-pane tm-pane-graph" id="tm-panel-grafik" data-active={pane === 'grafik'} aria-label="Grafik">
          <AgentVisualizer projectId={model.selectedId} />
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
