'use client'

import { useEffect, useRef, useCallback } from 'react'
import { COLORS } from '@/lib/colors'
import type { SessionInfo } from '@/lib/vscode-bridge'
import { CLOUD_LABEL, originHint, originMarks, STALE_LABEL } from '@/lib/cloud-origin'
import { HISTORY_HINT, historyToggleLabel, historyToggleVisible, sessionDot } from '@/lib/session-list'

/** Small text tag after a tab's title: "Cloud", or "Terputus" (dashed: not live right now, not an error). */
function OriginTag({ dashed, children }: { dashed?: boolean; children: React.ReactNode }) {
  return (
    <span
      className="flex-shrink-0"
      style={{
        padding: '0 4px',
        borderRadius: 4,
        border: `1px ${dashed ? 'dashed' : 'solid'} ${dashed ? COLORS.textMuted : COLORS.tabInactiveBorder}`,
        color: COLORS.textMuted,
        lineHeight: 1.35,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  /** History sessions the toggle would reveal (off) or hide (on): the number in its label */
  historyCount?: number
  /** All history sessions of the shown project (completed, or a cloud session stale for 10 minutes); 0 hides the toggle */
  historyTotal?: number
  showHistory?: boolean
  onToggleHistory?: () => void
}

export function SessionTabs({
  sessions,
  selectedSessionId,
  sessionsWithActivity,
  onSelectSession,
  onCloseSession,
  historyCount = 0,
  historyTotal = historyCount,
  showHistory = false,
  onToggleHistory,
}: SessionTabsProps) {
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  const setButtonRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) buttonRefs.current.set(id, el)
    else buttonRefs.current.delete(id)
  }, [])

  // Scroll selected tab into view whenever it changes
  useEffect(() => {
    if (!selectedSessionId) return
    const el = buttonRefs.current.get(selectedSessionId)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [selectedSessionId])

  return (
    // Session titles are shown in full: tabs wrap onto more lines instead of cutting the title.
    <div className="flex flex-wrap gap-1">
      {sessions.map(session => {
        const isSelected = session.id === selectedSessionId
        const hasActivity = sessionsWithActivity.has(session.id)
        const marks = originMarks(session)
        // Green dot: an active session. A disconnected cloud session is not live right now: hollow (no green, no
        // pulse) until the container reports again. An ended (completed) session is never green (lib/session-list.ts)
        const dot = sessionDot({ status: session.status, stale: marks.stale, hasActivity, isSelected })
        const hint = originHint(marks)
        const title = [session.prompt ? `Prompt pertama: ${session.prompt}` : '', hint].filter(Boolean).join('\n')
        return (
          <button
            key={session.id}
            ref={(el) => setButtonRef(session.id, el)}
            onClick={() => onSelectSession(session.id)}
            title={title || undefined}
            className="group px-1.5 py-0.5 rounded transition-all flex items-center gap-1"
            style={{
              flexShrink: 1,
              // Never narrower than a readable column, never wider than a comfortable one
              minWidth: 'min(140px, 100%)',
              maxWidth: 'min(280px, 100%)',
              whiteSpace: 'normal',
              overflowWrap: 'anywhere',
              textAlign: 'left',
              background: isSelected ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
              border: `1px solid ${isSelected ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
              color: isSelected ? COLORS.holoBright : COLORS.textMuted,
            }}
          >
            <span
              className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={dot.hollow ? {
                background: 'transparent',
                border: `1px solid ${COLORS.textMuted}`,
              } : {
                background: dot.green ? COLORS.complete : COLORS.idle + '40',
                boxShadow: dot.green ? `0 0 4px ${COLORS.complete}` : 'none',
                animation: dot.pulse ? 'pulse 1.5s infinite' : 'none',
              }}
            />
            {session.label}
            {marks.cloud && <OriginTag>{CLOUD_LABEL}</OriginTag>}
            {marks.stale && <OriginTag dashed>{STALE_LABEL}</OriginTag>}
            <span
              className="ml-0.5 opacity-0 group-hover:opacity-60 transition-opacity cursor-pointer"
              style={{ color: COLORS.tabClose, fontSize: 8, lineHeight: '10px' }}
              title="Tutup sesi ini"
              role="button"
              aria-label="Tutup sesi ini"
              onClick={(e) => {
                e.stopPropagation()
                onCloseSession(session.id)
              }}
            >
              ✕
            </span>
          </button>
        )
      })}
      {onToggleHistory && historyToggleVisible(historyTotal, true) && (
        // Same size and colours as a tab; the dashed border (as on "Terputus") says it is not a session
        <button
          type="button"
          onClick={onToggleHistory}
          aria-pressed={showHistory}
          title={HISTORY_HINT}
          className="px-1.5 py-0.5 rounded transition-all flex items-center"
          style={{
            flexShrink: 0,
            whiteSpace: 'nowrap',
            background: COLORS.tabInactiveBg,
            border: `1px dashed ${showHistory ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
            color: showHistory ? COLORS.holoBright : COLORS.textMuted,
          }}
        >
          {historyToggleLabel(showHistory, historyCount)}
        </button>
      )}
    </div>
  )
}
