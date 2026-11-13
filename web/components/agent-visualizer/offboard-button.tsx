'use client'

import { useState } from 'react'
import { COLORS } from '@/lib/colors'
import type { OffboardResult } from '@/lib/team/offboard'

type RunState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string }

/**
 * One offboard action with honest states: busy while the request runs, the server's refusal in plain text.
 * On success the node disappears (the card or button goes with it), so there is no success text to show.
 */
export function OffboardButton({ label, busyLabel, onRun, title }: {
  label: string
  busyLabel: string
  onRun: () => Promise<OffboardResult>
  title?: string
}) {
  const [state, setState] = useState<RunState>({ kind: 'idle' })
  const busy = state.kind === 'busy'

  async function run() {
    if (busy) return
    setState({ kind: 'busy' })
    const r = await onRun()
    setState(r.ok ? { kind: 'idle' } : { kind: 'error', message: r.message })
  }

  return (
    <div className="flex flex-col gap-1 items-stretch">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        title={title}
        className="tm-offboard-btn rounded-lg px-3 text-[11px] font-semibold"
        style={{
          minHeight: 44,
          background: COLORS.toggleInactive,
          border: `1px solid ${COLORS.toggleBorder}`,
          color: COLORS.textPrimary,
        }}
      >
        {busy ? busyLabel : label}
      </button>
      <span role="status" aria-live="polite" className="text-[11px]" style={{ color: COLORS.error, overflowWrap: 'anywhere' }}>
        {state.kind === 'error' ? state.message : ''}
      </span>
    </div>
  )
}
