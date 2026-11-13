"use client"

import { memo, useEffect, useRef } from "react"
import { Z } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"
import { useGraphTheme } from "@/hooks/use-graph-theme"
import { formatTokens } from "@/lib/utils"
import { agentCost } from "./canvas/draw-cost"
import { SessionTabs } from "./session-tabs"
import type { SessionInfo, ConnectionStatus } from "@/lib/bridge-types"
import type { OffboardResult } from "@/lib/team/offboard"
import { OffboardButton } from "./offboard-button"

// ─── Mute/Unmute SVG Icons ───────────────────────────────────────────────────

function MutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  )
}

function UnmutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

// ─── Toggle Button ──────────────────────────────────────────────────────────

function ToggleButton({ active, onClick, children, style, activeColor, title }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  style?: React.CSSProperties
  activeColor?: { bg: string; text: string }
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className="px-1.5 py-0.5 rounded transition-all"
      style={{
        background: active ? (activeColor?.bg ?? COLORS.toggleActive) : COLORS.toggleInactive,
        border: `1px solid ${COLORS.toggleBorder}`,
        color: active ? (activeColor?.text ?? COLORS.holoBright) : COLORS.textMuted,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

// ─── Connection Status Indicator ────────────────────────────────────────────

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const color = status === 'watching' ? COLORS.complete
    : status === 'connected' ? COLORS.idle : COLORS.error
  const label = status === 'watching' ? 'LANGSUNG'
    : status === 'connected' ? 'TERHUBUNG' : 'PUTUS'

  return (
    <span className="flex items-center gap-1.5">
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  )
}

// ─── Top Bar ────────────────────────────────────────────────────────────────

export interface TopBarProps {
  // Session tabs
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  // Connection
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  // Stats
  agentCount: number
  totalTokens: number
  // Panel toggles
  showFileAttention: boolean
  showTranscript: boolean
  showCostOverlay: boolean
  showTimeline: boolean
  isMuted: boolean
  onTogglePanel: (panel: 'files' | 'transcript' | 'cost') => void
  onToggleTimeline: () => void
  onToggleMute: () => void
  /** Finished sub-agents that can be offboarded here (0 hides the action) */
  finishedCount?: number
  onOffboardAll?: () => Promise<OffboardResult>
  /** Failure of an offboard started from the node menu, in plain text */
  offboardNotice?: string
  /** Reports where the bars end, so floating canvas panels can sit below them */
  onLayout?: (layout: TopBarLayout) => void
  /** Rendered in flow under the bars (the collapsed message card), so it never overlaps them */
  children?: React.ReactNode
}

export interface TopBarLayout {
  width: number
  /** Bottom edge of the tabs and the stats/toggles rows */
  barsBottom: number
  /** Bottom edge of everything, including the children */
  stackBottom: number
}

export const TopBar = memo(function TopBar({
  sessions, selectedSessionId, sessionsWithActivity,
  onSelectSession, onCloseSession,
  isVSCode, connectionStatus,
  agentCount, totalTokens,
  showFileAttention, showTranscript, showCostOverlay, showTimeline, isMuted,
  onTogglePanel, onToggleTimeline, onToggleMute,
  finishedCount = 0, onOffboardAll, offboardNotice,
  onLayout, children,
}: TopBarProps) {
  useGraphTheme()
  const rootRef = useRef<HTMLDivElement>(null)
  const barsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    const bars = barsRef.current
    if (!root || !bars || !onLayout) return
    const report = () => {
      const r = root.getBoundingClientRect()
      onLayout({ width: r.width, barsBottom: bars.getBoundingClientRect().bottom, stackBottom: r.bottom })
    }
    report()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(report)
    ro.observe(root)
    ro.observe(bars)
    return () => ro.disconnect()
  }, [onLayout])

  return (
    // The whole top area is one column: tabs on their own full-width row, then the
    // stats and toggles (wrapping on narrow screens), then the message card.
    // The column ignores the pointer so the canvas stays draggable between the pieces.
    <div ref={rootRef} className="absolute top-3 left-3 right-3 flex flex-col gap-2 font-mono text-[10px] pointer-events-none" style={{ zIndex: Z.info }}>
      <div ref={barsRef} className="flex flex-col gap-2">
      {/* Session tabs: own row, each tab keeps a readable width and wraps its title */}
      {sessions.length > 1 && (
        <div className="w-full pointer-events-auto">
          <SessionTabs
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            sessionsWithActivity={sessionsWithActivity}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
          />
        </div>
      )}

      {/* Stats and toggles: right aligned, wrap onto a second row instead of running off the edge */}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5 self-end max-w-full pointer-events-auto" style={{ color: COLORS.textMuted }}>
        {isVSCode && <ConnectionIndicator status={connectionStatus} />}
        <span>{agentCount} agent</span>
        <span>
          {formatTokens(totalTokens)} tokens
          <span style={{ color: COLORS.complete + '65', marginLeft: 4 }}>
            ~${agentCost(totalTokens).toFixed(2)}
          </span>
        </span>

        {/* Mutually exclusive panel group */}
        <div className="flex items-center gap-1 px-1 py-0.5 rounded" style={{
          background: COLORS.holoBg03,
          border: `1px solid ${COLORS.holoBorder06}`,
        }}>
          <ToggleButton active={showFileAttention} onClick={() => onTogglePanel('files')} title="File yang paling banyak dibaca atau diubah" style={{ background: showFileAttention ? undefined : 'transparent', border: 'none' }}>File</ToggleButton>
          <ToggleButton active={showTranscript} onClick={() => onTogglePanel('transcript')} title="Riwayat obrolan sesi ini" style={{ background: showTranscript ? undefined : 'transparent', border: 'none' }}>Obrolan</ToggleButton>
          <ToggleButton
            active={showCostOverlay}
            onClick={() => onTogglePanel('cost')}
            title="Perkiraan biaya per agent dan per alat"
            activeColor={{ bg: COLORS.costActiveBg, text: COLORS.complete }}
            style={{ background: showCostOverlay ? undefined : 'transparent', border: 'none' }}
          >
            Biaya
          </ToggleButton>
        </div>

        {/* Independent toggles */}
        <ToggleButton active={showTimeline} onClick={onToggleTimeline} title="Linimasa kerja tiap agent">Linimasa</ToggleButton>
        <ToggleButton active={!isMuted} onClick={onToggleMute} title={isMuted ? 'Nyalakan suara' : 'Matikan suara'} style={{ border: `1px solid ${COLORS.toggleBorder}` }}>
          <span className="inline-flex items-center gap-1">
            {isMuted ? <MutedIcon /> : <UnmutedIcon />}
            {isMuted ? 'Suara: mati' : 'Suara: nyala'}
          </span>
        </ToggleButton>
      </div>
      {/* Offboarding finished agents (D22): own row so its status text has room and never pushes the toggles */}
      {(finishedCount > 0 && onOffboardAll || offboardNotice) && (
        <div className="self-end max-w-full pointer-events-auto flex flex-col items-end gap-1" style={{ maxWidth: 'min(100%, 320px)' }}>
          {finishedCount > 0 && onOffboardAll && (
            <OffboardButton
              label={`Offboard semua yang selesai (${finishedCount})`}
              busyLabel="Lagi offboard…"
              title="Semua agent yang sudah selesai hilang dari grafik dan masuk daftar Selesai kontrak"
              onRun={onOffboardAll}
            />
          )}
          {offboardNotice && (
            <span role="status" className="text-[11px] text-right" style={{ color: COLORS.error, overflowWrap: 'anywhere' }}>
              {offboardNotice}
            </span>
          )}
        </div>
      )}
      </div>
      {children && <div className="self-start max-w-full pointer-events-auto">{children}</div>}
    </div>
  )
})
