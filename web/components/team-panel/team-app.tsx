"use client"

import { useCallback, useEffect, useState } from 'react'
import { AgentVisualizer } from '@/components/agent-visualizer'
import { nextThemePref, parseThemePref, resolveTheme, type ThemePref } from '@/lib/team/session'
import { readStored, writeStored } from './storage'
import { TeamPanel } from './team-panel'
import { useTeamModel } from './use-team-model'
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
  const systemDark = useSystemDark()
  const [theme, setTheme] = useState<ThemePref>(() => parseThemePref(readStored('tm-theme')))
  const [calm, setCalm] = useState(() => readStored('tm-calm') === '1')
  const [pane, setPane] = useState<Pane>('tim')

  const cycleTheme = useCallback(() => {
    setTheme((t) => {
      const n = nextThemePref(t)
      writeStored('tm-theme', n)
      return n
    })
  }, [])
  const toggleCalm = useCallback(() => {
    setCalm((c) => {
      writeStored('tm-calm', c ? '0' : '1')
      return !c
    })
  }, [])

  const open = model.view === 'ready' ? model.vm.openDecisions : 0

  return (
    <div className={`tm-root tm-app${calm ? ' tm-calm' : ''}`} data-tm-theme={resolveTheme(theme, systemDark)}>
      <div className="tm-panes">
        <main className="tm-pane tm-pane-team" id="tm-panel-tim" data-active={pane === 'tim'} aria-label="Tim">
          <TeamPanel model={model} theme={theme} onCycleTheme={cycleTheme} calm={calm} onToggleCalm={toggleCalm} />
        </main>
        <section className="tm-pane tm-pane-graph" id="tm-panel-grafik" data-active={pane === 'grafik'} aria-label="Grafik">
          <AgentVisualizer />
        </section>
      </div>
      <nav className="tm-nav" role="tablist" aria-label="Tampilan">
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'tim'}
          aria-controls="tm-panel-tim"
          onClick={() => setPane('tim')}
        >
          Tim
          {open > 0 && (
            <span className="count" aria-label={`${open} keputusan butuh kamu`}>
              {open}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'grafik'}
          aria-controls="tm-panel-grafik"
          onClick={() => setPane('grafik')}
        >
          Grafik
        </button>
      </nav>
    </div>
  )
}
