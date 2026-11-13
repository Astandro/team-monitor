"use client"

import { useEffect, useRef } from 'react'
import { SoundGate } from '@/lib/sound/gate'
import { playCues } from '@/lib/sound/sound-client'
import { TeamSoundTracker } from '@/lib/sound/team-diff'
import { ChatReplyTracker, type ChatEntry } from '@/lib/team/chat'
import type { TeamState } from '@/lib/team/types'

/**
 * Plays the team panel sounds for each change of the selected project's state (never on load or after a switch).
 * A new reply from the coordinator in the chat reuses the panel's "new activity" cue (task_start, the soft chirp);
 * no new sound was added. playCues stays silent while sound is off.
 */
export function useTeamSounds(projectId: string | null, state: TeamState | null, chat: ChatEntry[] | null): void {
  const trackerRef = useRef<TeamSoundTracker | null>(null)
  const chatRef = useRef<ChatReplyTracker | null>(null)
  const gateRef = useRef<SoundGate | null>(null)
  if (trackerRef.current === null) trackerRef.current = new TeamSoundTracker()
  if (chatRef.current === null) chatRef.current = new ChatReplyTracker()
  if (gateRef.current === null) gateRef.current = new SoundGate()

  useEffect(() => {
    const cues = trackerRef.current!.step(projectId, state)
    if (cues.length > 0) playCues(gateRef.current!.admit(cues, performance.now()))
  }, [projectId, state])

  useEffect(() => {
    if (chatRef.current!.step(projectId, chat)) playCues(gateRef.current!.admit(['task_start'], performance.now()))
  }, [projectId, chat])
}
