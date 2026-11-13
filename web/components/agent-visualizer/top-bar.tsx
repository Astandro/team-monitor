"use client"

import { memo, useCallback, useEffect, useId, useRef, useState } from "react"
import { Z } from "@/lib/agent-types"
import { isCompactGraph } from "@/lib/graph-fit"
import { useClickOutside } from "@/hooks/use-click-outside"
import { COLORS } from "@/lib/colors"
import { useGraphTheme } from "@/hooks/use-graph-theme"
import { formatTokens } from "@/lib/utils"
import { agentCost } from "./canvas/draw-cost"
import { SessionTabs } from "./session-tabs"
import type { SessionInfo, ConnectionStatus } from "@/lib/bridge-types"
import type { OffboardResult } from "@/lib/team/offboard"
import { OffboardButton } from "./offboard-button"
import { SoundControl } from "./sound-control"

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

// ─── Phone menu ─────────────────────────────────────────────────────────────

type MenuProps = Pick<TopBarProps,
  'isVSCode' | 'connectionStatus' | 'agentCount' | 'totalTokens' | 'showFileAttention' | 'showTranscript' |
  'showCostOverlay' | 'showTimeline' | 'onTogglePanel' | 'onToggleTimeline' | 'finishedCount' | 'onOffboardAll' |
  'offboardNotice'>

/**
 * Phone only: everything the wide bar shows in a row (numbers, File / Obrolan / Biaya, Linimasa, Offboard semua) sits
 * behind one 44 px button, so the graph keeps its top area. A disclosure, not an ARIA menu: Tab moves through the
 * buttons inside, Escape and a tap outside close it and focus goes back to the button.
 */
function GraphMenu({
  isVSCode, connectionStatus, agentCount, totalTokens,
  showFileAttention, showTranscript, showCostOverlay, showTimeline,
  onTogglePanel, onToggleTimeline, finishedCount = 0, onOffboardAll, offboardNotice,
}: MenuProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const close = useCallback(() => setOpen(false), [])
  useClickOutside(wrapRef, close)
  // An offboard refusal from the node menu opens nothing by itself; show a dot so it is not missed
  const attention = !!offboardNotice
  const row = (label: string, active: boolean, onClick: () => void, hint: string) => (
    <button
      type="button"
      aria-pressed={active}
      title={hint}
      onClick={() => { onClick(); setOpen(false) }}
      className="tm-graph-menu-item w-full text-left rounded-lg px-3 text-[12px] font-semibold"
      style={{
        minHeight: 44,
        background: active ? COLORS.toggleActive : undefined,
        border: `1px solid ${active ? COLORS.toggleBorder : 'transparent'}`,
        color: active ? COLORS.holoBright : COLORS.textPrimary,
      }}
    >
      {label}
    </button>
  )
  return (
    <div
      ref={wrapRef}
      className="relative pointer-events-auto shrink-0"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); btnRef.current?.focus() }
      }}
    >
      <button
        ref={btnRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Menu grafik${finishedCount > 0 ? `, ${finishedCount} agent selesai bisa di-offboard` : ''}`}
        title="Menu grafik"
        onClick={() => setOpen((o) => !o)}
        className="tm-graph-menu-btn relative inline-flex items-center justify-center rounded-[10px]"
        style={{ width: 44, height: 44, background: COLORS.toggleInactive, border: `1px solid ${COLORS.toggleBorder}`, color: COLORS.textPrimary }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
        </svg>
        {attention && (
          <span aria-hidden="true" className="absolute rounded-full" style={{ top: 6, right: 6, width: 8, height: 8, background: COLORS.error }} />
        )}
      </button>
      {open && (
        <div
          id={panelId}
          className="glass-card absolute right-0 flex flex-col gap-1"
          style={{ top: 'calc(100% + 6px)', width: 'min(260px, calc(100vw - 24px))', padding: 8, zIndex: 5, color: COLORS.textPrimary }}
        >
          <div className="px-3 py-1 text-[12px] flex flex-wrap gap-x-3" style={{ color: COLORS.textMuted }}>
            {isVSCode && <ConnectionIndicator status={connectionStatus} />}
            <span>{agentCount} agent</span>
            <span>
              {formatTokens(totalTokens)} tokens
              <span style={{ color: COLORS.complete, marginLeft: 4 }}>~${agentCost(totalTokens).toFixed(2)}</span>
            </span>
          </div>
          {row('File', showFileAttention, () => onTogglePanel('files'), 'File yang paling banyak dibaca atau diubah')}
          {row('Obrolan', showTranscript, () => onTogglePanel('transcript'), 'Riwayat obrolan sesi ini')}
          {row('Biaya', showCostOverlay, () => onTogglePanel('cost'), 'Perkiraan biaya per agent dan per alat')}
          {row('Linimasa', showTimeline, onToggleTimeline, 'Linimasa kerja tiap agent')}
          {finishedCount > 0 && onOffboardAll && (
            <div className="pt-1 mt-1" style={{ borderTop: `1px solid ${COLORS.toggleBorder}` }}>
              <OffboardButton
                label={`Offboard semua yang selesai (${finishedCount})`}
                busyLabel="Lagi offboard…"
                title="Semua agent yang sudah selesai hilang dari grafik dan masuk daftar Selesai kontrak"
                onRun={onOffboardAll}
              />
            </div>
          )}
          {offboardNotice && (
            <span role="status" className="px-3 text-[12px]" style={{ color: COLORS.error, overflowWrap: 'anywhere' }}>
              {offboardNotice}
            </span>
          )}
        </div>
      )}
    </div>
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
  onTogglePanel: (panel: 'files' | 'transcript' | 'cost') => void
  onToggleTimeline: () => void
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
  /** Phone-sized graph: the controls are one row (message card, sound, menu) */
  compact: boolean
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
  showFileAttention, showTranscript, showCostOverlay, showTimeline,
  onTogglePanel, onToggleTimeline,
  finishedCount = 0, onOffboardAll, offboardNotice,
  onLayout, children,
}: TopBarProps) {
  useGraphTheme()
  const rootRef = useRef<HTMLDivElement>(null)
  const barsRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    // The bar is inset 12 px on each side: the graph's own width decides (web/lib/graph-fit.ts)
    const measure = () => setCompact(isCompactGraph((root.parentElement ?? root).getBoundingClientRect().width))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(root.parentElement ?? root)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const root = rootRef.current
    const bars = barsRef.current
    if (!root || !bars || !onLayout) return
    const report = () => {
      const r = root.getBoundingClientRect()
      onLayout({ width: r.width, compact, barsBottom: bars.getBoundingClientRect().bottom, stackBottom: r.bottom })
    }
    report()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(report)
    ro.observe(root)
    ro.observe(bars)
    return () => ro.disconnect()
  }, [onLayout, compact])

  if (compact) {
    return (
      // Phone: one row. Message card (name · role, tap to open) on the left, sound and a menu with everything else
      // on the right. The card's slot has a fixed height, so an opened card floats over the graph instead of pushing
      // the row down (the auto-fit keeps the graph below this row).
      <div ref={rootRef} className="absolute top-3 left-3 right-3 flex flex-col gap-2 font-mono text-[10px] pointer-events-none" style={{ zIndex: Z.info }}>
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
        <div ref={barsRef} className="flex items-start gap-2">
          {/* z-index: an opened card covers the sound and menu buttons instead of sliding under them */}
          <div className="relative flex-1 min-w-0" style={{ height: 44, zIndex: 1 }}>
            {children && <div className="absolute left-0 top-0 max-w-full pointer-events-auto">{children}</div>}
          </div>
          <div className="pointer-events-auto shrink-0">
            <SoundControl />
          </div>
          <GraphMenu
            isVSCode={isVSCode}
            connectionStatus={connectionStatus}
            agentCount={agentCount}
            totalTokens={totalTokens}
            showFileAttention={showFileAttention}
            showTranscript={showTranscript}
            showCostOverlay={showCostOverlay}
            showTimeline={showTimeline}
            onTogglePanel={onTogglePanel}
            onToggleTimeline={onToggleTimeline}
            finishedCount={finishedCount}
            onOffboardAll={onOffboardAll}
            offboardNotice={offboardNotice}
          />
        </div>
      </div>
    )
  }

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
        {/* The page's only sound control: mute button plus a volume popover */}
        <SoundControl />
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
