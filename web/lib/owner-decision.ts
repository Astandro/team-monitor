// "Butuh jawaban owner" on the graph (spec 0.9.7): while a decision in state.json is open, the node of the agent
// that asked shows the owner state (red, triangle, "Butuh jawaban" tag, the owner loop). Pure, unit tested
// (owner-decision.test.ts).
//
// Which node: an approval may name the asking agent in `agent` (a key of `agents` in state.json, or a name or nick
// as written there). That agent's node on the graph shows the state; when the approval names no agent, or the named
// agent has no node on the graph, the coordinator (main) node shows it. Answering the decision clears it.

import { agentIdentity, type CoordinatorInfo } from './agent-identity'
import type { TeamApproval, TeamState } from './team/types'

/** Text of the blinking tag under the node's name. */
export const OWNER_TAG = 'Butuh jawaban'

/** One blink of the tag (seconds): two per turn of the owner loop (2.2 s). */
export const OWNER_BLINK_PERIOD_S = 1.1

/**
 * How a node calls for attention on the graph. The owner state wins over waiting for permission on the same node.
 * Both have the dashed ring, ripples, orbiting particles and breathing; the owner state has three ripples instead
 * of two, the warning triangle instead of the lock and a blinking tag. Under reduced motion nothing moves: the
 * icon, a still dashed ring and a still tag stay, no ripples, no particles, no breathing, no blink.
 */
export interface NodeAlert {
  kind: 'owner' | 'waiting'
  icon: 'warning' | 'lock'
  /** ripple rings to draw (0 under reduced motion) */
  ripples: number
  /** orbiting particles, breathing, moving dashes and the blink */
  animated: boolean
  /** tag under the label, or null */
  tag: string | null
}

export function nodeAlert(state: string, isOwner: boolean, reducedMotion: boolean): NodeAlert | null {
  const animated = !reducedMotion
  if (isOwner) return { kind: 'owner', icon: 'warning', ripples: animated ? 3 : 0, animated, tag: OWNER_TAG }
  if (state === 'waiting_permission') return { kind: 'waiting', icon: 'lock', ripples: animated ? 2 : 0, animated, tag: null }
  return null
}

/** The tag's blink, 0..1 (0 = fully shown); always 0 when the alert does not move. */
export function ownerTagPulse(time: number, animated: boolean): number {
  if (!animated) return 0
  return 0.5 - 0.5 * Math.cos((time / OWNER_BLINK_PERIOD_S) * Math.PI * 2)
}

/** One open decision and the names its asker may carry on the graph (empty: the coordinator asked). */
export interface OwnerAsk {
  id: string
  names: string[]
}

/** What ownerNodeIds reads of a graph node (lib/agent-types Agent). */
export interface OwnerNode {
  id: string
  name: string
  isMain: boolean
  state: string
  displayName?: string
  role?: string
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const norm = (s: string) => s.trim().toLowerCase()

/** Open as the team panel counts it: status "open" and no answer yet. */
export function isOpenApproval(ap: TeamApproval | null | undefined): boolean {
  if (!ap || ap.status !== 'open') return false
  return text(ap.answer) === ''
}

/** The open decisions of a state.json, in id order, each with the names its asker may carry. */
export function openOwnerAsks(state: TeamState | null | undefined): OwnerAsk[] {
  const out: OwnerAsk[] = []
  const agents = state?.agents ?? {}
  for (const [id, ap] of Object.entries(state?.approvals ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isOpenApproval(ap)) continue
    const asked = text(ap?.agent)
    const names = new Set<string>()
    if (asked) {
      names.add(asked)
      // the same agent under its key, name and nick in state.json
      for (const [key, ag] of Object.entries(agents)) {
        const own = [key, text(ag?.name), text(ag?.nick)].filter(Boolean)
        if (own.some((n) => norm(n) === norm(asked))) for (const n of own) names.add(n)
      }
    }
    out.push({ id, names: [...names] })
  }
  return out
}

/** Stable key of the asks for React dependencies (a new state.json object with the same open asks is no change). */
export function ownerAsksKey(asks: readonly OwnerAsk[]): string {
  return asks.map((a) => `${a.id}:${a.names.join('|')}`).join(',')
}

/**
 * Ids of the graph nodes in the owner state. A named asker matches a node that has not finished by its shown name,
 * its display name or its raw name (case-insensitive). No name, or no such node: the coordinator (main) node. No
 * main node either: nothing on the graph (the owner loop still plays, see use-audio-effects.ts).
 */
export function ownerNodeIds(nodes: Iterable<OwnerNode>, asks: readonly OwnerAsk[], coordinator?: CoordinatorInfo | null): Set<string> {
  const out = new Set<string>()
  if (asks.length === 0) return out
  const list = [...nodes]
  const main = list.find((n) => n.isMain && n.state !== 'complete') ?? list.find((n) => n.isMain)
  for (const ask of asks) {
    const wanted = new Set(ask.names.map(norm))
    const matches = wanted.size === 0 ? [] : list.filter((n) => {
      const shown = agentIdentity(n, coordinator).name
      return [shown, text(n.displayName), text(n.name)].some((s) => s !== '' && wanted.has(norm(s)))
    })
    // a finished node (fading out before its offboard) cannot be waiting for an answer: then the coordinator shows it
    const pick = matches.find((n) => n.state !== 'complete') ?? main
    if (pick) out.add(pick.id)
  }
  return out
}
