'use client'

import { COLORS } from '@/lib/colors'
import { Z } from '@/lib/agent-types'

/**
 * Small "re-centre" button over the graph (owner feedback 13 Nov): after panning or pinching away, one tap brings the
 * Orchestrator and the sub-agents at work back into view (same as double click / "Pas-kan ke layar" on desktop).
 * Sits at the right edge just above the bottom control bar; 44 px target.
 */
export function RecenterButton({ onClick }: { onClick: () => void }) {
  const label = 'Pusatkan lagi ke Orchestrator'
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="tm-graph-menu-btn tm-recenter absolute inline-flex items-center justify-center rounded-[10px]"
      style={{
        right: 16,
        bottom: 92,
        width: 44,
        height: 44,
        zIndex: Z.controlBar,
        background: COLORS.toggleInactive,
        border: `1px solid ${COLORS.toggleBorder}`,
        color: COLORS.textPrimary,
      }}
    >
      {/* crosshair: a ring with four ticks, the centre mark of a map */}
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      </svg>
    </button>
  )
}
