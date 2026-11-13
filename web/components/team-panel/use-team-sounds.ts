"use client"

import { useEffect, useRef } from 'react'
import { SoundGate } from '@/lib/sound/gate'
import { playCues } from '@/lib/sound/sound-client'
import { TeamSoundTracker } from '@/lib/sound/team-diff'
import type { TeamState } from '@/lib/team/types'

/** Plays the team panel sounds for each change of the selected project's state (never on load or after a switch). */
export function useTeamSounds(projectId: string | null, state: TeamState | null): void {
  const trackerRef = useRef<TeamSoundTracker | null>(null)
  const gateRef = useRef<SoundGate | null>(null)
  if (trackerRef.current === null) trackerRef.current = new TeamSoundTracker()
  if (gateRef.current === null) gateRef.current = new SoundGate()

  useEffect(() => {
    const cues = trackerRef.current!.step(projectId, state)
    if (cues.length > 0) playCues(gateRef.current!.admit(cues, performance.now()))
  }, [projectId, state])
}
