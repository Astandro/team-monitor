import { useRef, useEffect } from 'react'
import type { Agent, Particle, ToolCallNode } from '@/lib/agent-types'
import type { SessionInfo } from '@/lib/bridge-types'
import { detectStateChanges } from '@/components/agent-visualizer/canvas/detect-state-changes'
import { cueForGraphTransition, isHandoffParticle, type SoundCue } from '@/lib/sound/cues'
import { SoundGate, startedSessions } from '@/lib/sound/gate'
import { playCues } from '@/lib/sound/sound-client'
import { OFFBOARDED_EVENT } from '@/lib/team/offboard'
import { useSoundSettings } from './use-sound-settings'

interface AudioEffectsInput {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  particles: Particle[]
  isReviewing: boolean
  /** selected session: a switch replays that session's history, which stays quiet */
  sessionKey: string | null
  sessions: SessionInfo[]
}

/** Graph events to sounds. Mute and volume are the page-wide settings (useSoundSettings). */
export function useAudioEffects({ agents, toolCalls, particles, isReviewing, sessionKey, sessions }: AudioEffectsInput) {
  const sound = useSoundSettings()
  const seekingRef = useRef(false)
  const gateRef = useRef<SoundGate | null>(null)
  if (gateRef.current === null) gateRef.current = new SoundGate()
  const mountedAtRef = useRef(Date.now())
  const seenSessionsRef = useRef<Set<string>>(new Set())
  const prevToolStatesRef = useRef<Map<string, string>>(new Map())
  const prevAgentStatesRef = useRef<Map<string, string>>(new Map())
  const prevParticleIdsRef = useRef<Set<string>>(new Set())

  // Quiet window on mount, on a session switch and when leaving review: the graph replays history then.
  // Declared before the detection effect so it applies to the same commit.
  useEffect(() => {
    gateRef.current!.reset(performance.now())
  }, [sessionKey, isReviewing])

  // Power-up when a session starts while the page is open (not for sessions listed on load)
  useEffect(() => {
    const started = startedSessions(seenSessionsRef.current, sessions, mountedAtRef.current)
    for (const s of sessions) seenSessionsRef.current.add(s.id)
    if (started.length > 0) playCues(gateRef.current!.admit(['session_start'], performance.now()))
  }, [sessions])

  // An instance left the team (server auto-offboard or the owner's Offboard): a distant meteor burning up.
  // The same quiet window applies, so offboards caught up right after load stay silent.
  useEffect(() => {
    const onOffboarded = (e: Event) => {
      const agents = (e as CustomEvent<{ agents?: unknown }>).detail?.agents
      if (Array.isArray(agents) && agents.length === 0) return
      playCues(gateRef.current!.admit(['agent_offboarded'], performance.now()))
    }
    window.addEventListener(OFFBOARDED_EVENT, onOffboarded)
    return () => window.removeEventListener(OFFBOARDED_EVENT, onOffboarded)
  }, [])

  // Detect tool/agent state transitions and handoffs, play sounds (live mode only).
  // The baselines follow every frame, also while seeking or reviewing, so going back to live is not a burst.
  useEffect(() => {
    const { transitions, newAgentStates, newToolStates } = detectStateChanges(
      agents, toolCalls,
      prevAgentStatesRef.current, prevToolStatesRef.current,
    )
    prevAgentStatesRef.current = newAgentStates
    prevToolStatesRef.current = newToolStates

    const cues: SoundCue[] = transitions.map((t) => cueForGraphTransition(t.kind))

    const prevParticles = prevParticleIdsRef.current
    const particleIds = new Set<string>()
    for (const p of particles) {
      particleIds.add(p.id)
      if (!prevParticles.has(p.id) && isHandoffParticle(p.type)) cues.push('handoff')
    }
    prevParticleIdsRef.current = particleIds

    if (seekingRef.current || isReviewing) return
    if (cues.length > 0) playCues(gateRef.current!.admit(cues, performance.now()))
  }, [agents, toolCalls, particles, isReviewing])

  return { isMuted: sound.muted, seekingRef, handleToggleMute: sound.toggle }
}
