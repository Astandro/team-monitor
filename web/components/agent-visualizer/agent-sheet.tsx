'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { nextSheetView, SHEET, sheetMaxHeight, type SheetView } from '@/lib/sheet-layout'
import type { CoordinatorInfo } from '@/lib/agent-identity'
import type { OffboardResult } from '@/lib/team/offboard'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { AgentDetailBody, AgentDetailHead, type DetailAgent } from './agent-detail-card'
import { TranscriptMessage } from './transcript-message'

/**
 * Phones and tablets (web/lib/sheet-layout.ts): one bottom sheet for the tapped agent, full width, above the play bar
 * and below the top controls, its own scroll. Detail first; "Lihat percakapan" swaps the same sheet to the transcript.
 * The close button, Escape, or a tap on the graph close it.
 */
export function AgentSheet({ agent, coordinator, conversation, runtime, onOffboard, onClose, topReserve }: {
  agent: DetailAgent
  coordinator?: CoordinatorInfo | null
  conversation: ConversationMessage[]
  runtime?: 'claude' | 'codex'
  onOffboard?: (agentId: string) => Promise<OffboardResult>
  onClose: () => void
  /** Screen px at the top taken by the graph's controls */
  topReserve: number
}) {
  const [view, setView] = useState<SheetView>('detail')
  const rootRef = useRef<HTMLElement>(null)
  const [paneH, setPaneH] = useState(0)

  useEffect(() => setView((v) => nextSheetView(v, 'agent-changed')), [agent.id])

  // the graph's height, from the element the sheet is positioned in
  useLayoutEffect(() => {
    const parent = rootRef.current?.offsetParent as HTMLElement | null
    if (!parent) return
    const read = () => setPaneH(parent.clientHeight)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { ref: logRef } = useAutoScroll(conversation.length, view === 'transcript')
  const maxHeight = paneH > 0 ? sheetMaxHeight(paneH, topReserve) : undefined
  const label = 'Detail agent'

  return (
    <section
      ref={rootRef}
      aria-label={label}
      className="tm-sheet glass-card"
      style={{
        position: 'absolute',
        left: SHEET.side,
        right: SHEET.side,
        bottom: `calc(${SHEET.bottom}px + env(safe-area-inset-bottom, 0px))`,
        maxHeight,
        zIndex: Z.detailCard,
        display: 'flex',
        flexDirection: 'column',
        padding: 0,
        overflow: 'hidden',
      }}
    >
      <div className="flex items-start justify-between gap-2" style={{ padding: '10px 6px 8px 14px', borderBottom: `1px solid ${COLORS.glassBorder}` }}>
        <div className="flex items-center gap-2 min-w-0 pt-1">
          <AgentDetailHead agent={agent} coordinator={coordinator} />
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup detail agent"
          title="Tutup"
          className="tm-sheet-close inline-flex items-center justify-center flex-shrink-0 rounded-[10px]"
          style={{ width: 44, height: 44, color: COLORS.textPrimary }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      {view === 'detail' ? (
        <div className="tm-sheet-scroll" style={{ overflowY: 'auto', overscrollBehavior: 'contain', padding: '12px 14px 14px' }}>
          <AgentDetailBody agent={agent} onOffboard={onOffboard} />
          <button
            type="button"
            className="tm-sheet-action w-full rounded-[10px] text-[12px] font-semibold"
            style={{ minHeight: 44, marginTop: 4, background: COLORS.toggleInactive, border: `1px solid ${COLORS.toggleBorder}`, color: COLORS.textPrimary }}
            onClick={() => setView((v) => nextSheetView(v, 'open-transcript'))}
          >
            Lihat percakapan ({conversation.length} pesan)
          </button>
        </div>
      ) : (
        <>
          <div style={{ padding: '6px 10px 0' }}>
            <button
              type="button"
              className="tm-sheet-action inline-flex items-center gap-1 rounded-[10px] text-[12px] font-semibold"
              style={{ minHeight: 44, padding: '0 10px', color: COLORS.textPrimary }}
              onClick={() => setView((v) => nextSheetView(v, 'back'))}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 6l-6 6 6 6" />
              </svg>
              Kembali ke detail
            </button>
          </div>
          <div
            ref={logRef}
            className="tm-sheet-scroll space-y-1.5"
            style={{ overflowY: 'auto', overscrollBehavior: 'contain', padding: '4px 14px 14px', minHeight: 0, flex: 1 }}
          >
            {conversation.length === 0 ? (
              <p className="text-[11px]" style={{ color: COLORS.textMuted }}>Belum ada pesan.</p>
            ) : (
              conversation.map((msg) => (
                <TranscriptMessage key={msg.id} message={msg} assistantLabel={runtime === 'codex' ? 'CODEX' : 'CLAUDE'} />
              ))
            )}
          </div>
        </>
      )}
    </section>
  )
}
