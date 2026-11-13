"use client"

import { useCallback, useEffect, useState } from 'react'
import { AgentVisualizer } from '@/components/agent-visualizer'
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
  useTeamSounds(model.selectedId, model.state)
  const systemDark = useSystemDark()
  const [theme, setTheme] = useState<ThemePref>(() => parseThemePref(readStored('tm-theme')))
  const [calm, setCalm] = useState(() => readStored('tm-calm') === '1')
  const [pane, setPane] = useState<Pane>('tim')

  const cycleTheme = useCallback(() => setTheme((t) => nextThemePref(t)), [])
  const toggleCalm = useCallback(() => setCalm((c) => !c), [])
  // remembered after the state changed, not inside the state updaters
  useEffect(() => writeStored('tm-theme', theme), [theme])
  useEffect(() => writeStored('tm-calm', calm ? '1' : '0'), [calm])

  const open = model.view === 'ready' ? model.vm.openDecisions : 0

  return (
    <div className={`tm-root tm-app${calm ? ' tm-calm' : ''}`} data-tm-theme={resolveTheme(theme, systemDark)}>
      <div className="tm-panes">
        <main className="tm-pane tm-pane-team tm-themed" id="tm-panel-tim" data-active={pane === 'tim'} aria-label="Tim">
          <TeamPanel model={model} theme={theme} onCycleTheme={cycleTheme} calm={calm} onToggleCalm={toggleCalm} />
        </main>
        <section className="tm-pane tm-pane-graph" id="tm-panel-grafik" data-active={pane === 'grafik'} aria-label="Grafik">
          <AgentVisualizer />
        </section>
      </div>
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
