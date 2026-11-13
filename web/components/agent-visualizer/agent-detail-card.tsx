'use client'

import { CARD, Z, type AgentState } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { formatTokens, formatModelName } from '@/lib/utils'
import { toolLabel, stateLabel } from '@/lib/readable-labels'
import { agentIdentity, type CoordinatorInfo } from '@/lib/agent-identity'
import { canOffboard, type OffboardResult } from '@/lib/team/offboard'
import { GlassCard } from './glass-card'
import { PanelHeader, ProgressBar } from './shared-ui'
import { OffboardButton } from './offboard-button'
import { autoOffboardText, type FinishedClock } from '@/lib/disintegration'

interface AgentDetailCardProps {
  agent: {
    id: string
    name: string
    state: AgentState
    isMain?: boolean
    displayName?: string
    role?: string
    model?: string
    tokensUsed: number
    tokensMax: number
    toolCalls: number
    timeAlive: number
    currentTool?: string
    finished?: FinishedClock
  }
  coordinator?: CoordinatorInfo | null
  /** Present when offboarding is possible here (standalone app with a selected session) */
  onOffboard?: (agentId: string) => Promise<OffboardResult>
  onClose: () => void
}

export function AgentDetailCard({
  agent,
  coordinator,
  onOffboard,
  onClose,
}: AgentDetailCardProps) {
  const contextPercent = Math.round((agent.tokensUsed / agent.tokensMax) * 100)
  const stateColor = getStateColor(agent.state)
  const id = agentIdentity(agent, coordinator)

  // Fixed position: middle-left of the screen (below message feed panel)
  const left = CARD.margin
  const top = typeof window !== 'undefined' ? Math.max(100, (window.innerHeight - CARD.detail.height) / 2) : 300

  return (
    <GlassCard
      visible={true}
      className="agent-detail-card"
      style={{
        position: 'absolute',
        left,
        top,
        width: CARD.detail.width,
        zIndex: Z.detailCard,
      }}
    >
      <PanelHeader onClose={onClose} className="mb-3">
        <div
          className="w-2 h-2 rounded-full"
          style={{ background: stateColor, boxShadow: `0 0 8px ${stateColor}` }}
        />
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-mono font-semibold break-words" style={{ color: COLORS.textPrimary, overflowWrap: 'anywhere' }}>
            {id.name}
          </span>
          {id.role && (
            <span className="text-[10px] font-mono break-words" style={{ color: COLORS.textMuted, overflowWrap: 'anywhere' }}>
              {id.role}
            </span>
          )}
          {agent.model && (
            <span className="text-[9px] font-mono" style={{ color: COLORS.textDim }}>
              {formatModelName(agent.model)}
            </span>
          )}
        </div>
      </PanelHeader>

      {/* Context bar */}
      <div className="mb-3">
        <div className="flex justify-between mb-1">
          <span className="text-[10px]" style={{ color: COLORS.textMuted }} title="Berapa banyak ruang ingatan agent yang sudah terpakai">Konteks</span>
          <span className="text-[10px] font-mono" style={{ color: COLORS.textDim }}>
            {formatTokens(agent.tokensUsed)} / {formatTokens(agent.tokensMax)} ({contextPercent}%)
          </span>
        </div>
        <ProgressBar percent={contextPercent} color={stateColor} />
      </div>

      {/* Stats row */}
      <div className="flex gap-3 mb-3 text-[10px] font-mono" style={{ color: COLORS.textDim }}>
        <span>{agent.toolCalls} alat dipakai</span>
        <span>aktif {agent.timeAlive.toFixed(1)} dtk</span>
        <span style={{ color: stateColor }}>{stateLabel(agent.state)}</span>
      </div>

      {/* Current tool */}
      {agent.currentTool && (
        <div
          className="mb-3 px-2 py-1.5 rounded text-[10px] font-mono flex items-center gap-2"
          style={{
            background: COLORS.toolIndicatorBg,
            border: `1px solid ${COLORS.toolIndicatorBorder}`,
            color: COLORS.toolIndicatorText,
          }}
        >
          <span className="animate-spin inline-block">⚙</span>
          {toolLabel(agent.currentTool)}
        </div>
      )}

      {/* When the server will offboard it by itself (one hour after it finished) */}
      {!agent.isMain && agent.state === 'complete' && agent.finished && (
        <div className="mb-2 text-[11px]" style={{ color: COLORS.textMuted }}>
          {autoOffboardText(agent.finished, Date.now())}
        </div>
      )}

      {/* Finished sub-agents only: running agents and the Orchestrator have no action (D22) */}
      {onOffboard && canOffboard(agent) && (
        <OffboardButton
          label="Offboard"
          busyLabel="Lagi offboard…"
          title="Tandai kontraknya selesai: hilang dari grafik, masuk daftar Selesai kontrak di panel tim"
          onRun={() => onOffboard(agent.id)}
        />
      )}

    </GlassCard>
  )
}
