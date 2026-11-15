import type { ContextBreakdown } from '@/lib/agent-types'
import type { ConversationMessage } from './types'
import { appendConversation, asString, asNumber, LABEL_LEN_TASK, LABEL_LEN_BUBBLE, MAX_BUBBLES } from './types'
import type { MutableEventState } from './process-event'
import { plainText } from '@/lib/plain-text'

export function handleMessage(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const content = asString(payload.content)
  const role = typeof payload.role === 'string' ? payload.role : undefined

  // Map role to conversation message type
  const msgType: ConversationMessage['type'] =
    role === 'user' ? 'user' :
    role === 'thinking' ? 'thinking' :
    'assistant'

  // The main node keeps its name ("Orchestrator", owner override 13 Nov). Upstream renamed it to the first user
  // message, which left the owner's prompt drawn under the node for good; the prompt now only becomes the node's
  // task (shown in the detail card) and a normal message bubble that fades after BUBBLE_VISIBLE_S.
  if (role === 'user') {
    const main = state.agents.get(agentName)
    if (main && main.isMain) {
      state.agents.set(agentName, { ...main, task: content.slice(0, LABEL_LEN_TASK) })
    }
  }

  // Update agent state and push message bubble to queue
  const msgAgent = state.agents.get(agentName)
  if (msgAgent) {
    const bubbleRole: 'user' | 'thinking' | 'assistant' = role === 'user' ? 'user' : role === 'thinking' ? 'thinking' : 'assistant'
    const updates: Partial<typeof msgAgent> = {}

    {
      // Truncate thinking for graph bubbles (full text in message feed panel)
      // Markdown marks never show raw on the canvas either (owner feedback 13 Nov)
      const plain = plainText(content)
      const bubbleText = bubbleRole === 'thinking' ? plain.slice(0, LABEL_LEN_BUBBLE) + (plain.length > LABEL_LEN_BUBBLE ? '...' : '') : plain
      // Dedup: skip if last bubble has the same text (dual event source race)
      const lastBubble = msgAgent.messageBubbles[msgAgent.messageBubbles.length - 1]
      if (!lastBubble || lastBubble.text !== bubbleText) {
        const newBubbles = [...msgAgent.messageBubbles, { text: bubbleText, time: currentTime, role: bubbleRole }]
        updates.messageBubbles = newBubbles.length > MAX_BUBBLES ? newBubbles.slice(-MAX_BUBBLES) : newBubbles
      }
    }

    // The main agent comes back from "complete" (end of a turn) as soon as it says something again; a finished
    // sub-agent stays complete.
    if ((msgAgent.state !== 'complete' || msgAgent.isMain) && msgAgent.state !== 'tool_calling') {
      if (role === 'user' || role === 'thinking' || role === 'assistant') {
        updates.state = 'thinking'
      }
    }
    if (Object.keys(updates).length > 0) {
      state.agents.set(agentName, { ...msgAgent, ...updates })
    }
  }

  appendConversation(state.conversations, agentName, { type: msgType, content, timestamp: currentTime })
}

export function handleContextUpdate(
  payload: Record<string, unknown>,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const tokens = asNumber(payload.tokens)
  const raw = payload.breakdown
  const breakdown = (raw && typeof raw === 'object' && 'systemPrompt' in raw) ? raw as ContextBreakdown : undefined
  // Optional override from runtimes that report an authoritative context window
  // (e.g. Codex's event_msg.token_count.info.model_context_window).
  const tokensMaxOverride = typeof payload.tokensMax === 'number' && payload.tokensMax > 0
    ? payload.tokensMax
    : undefined
  const agent = state.agents.get(agentName)
  if (agent) {
    state.agents.set(agentName, {
      ...agent,
      tokensUsed: tokens,
      tokensMax: tokensMaxOverride ?? agent.tokensMax,
      contextBreakdown: breakdown || agent.contextBreakdown,
      state: agent.state === 'complete' && !agent.isMain ? 'complete' : 'thinking'
    })
  }
}
