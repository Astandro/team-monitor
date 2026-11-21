/**
 * Shared relay module — receives agent events and streams them to SSE clients.
 * Used by both the dev relay server and the standalone app.
 */
import * as http from 'http'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { HookServer } from '../extension/src/hook-server'
import { AgentEvent, CoordinatorInfo, SessionInfo, WatchedSession } from '../extension/src/protocol'
import { TranscriptParser } from '../extension/src/transcript-parser'
import { readNewFileLines } from '../extension/src/fs-utils'
import { scanSubagentsDir, rebuildSubagentsOnAttach, readSubagentNewLines, newestSubagentMtime } from '../extension/src/subagent-watcher'
import { followSession } from '../extension/src/session-relocation'
import { handlePermissionDetection } from '../extension/src/permission-detection'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'
import {
  INACTIVITY_TIMEOUT_MS, SCAN_INTERVAL_MS, ACTIVE_SESSION_AGE_S, POLL_FALLBACK_MS,
  SESSION_ID_DISPLAY, SYSTEM_PROMPT_BASE_TOKENS, ORCHESTRATOR_NAME,
  HOOK_SERVER_NOT_STARTED, WORKSPACE_HASH_LENGTH,
} from '../extension/src/constants'
import { setLogLevel } from '../extension/src/logger'
import { LogLimiter } from './log-limit'
import { mainSpawnPayload, matchProjectDir, projectSessionLabel, sameCoordinator, watchTargets, type WatchedProject } from './session-projects'
import { GraphAgents, NO_OFFBOARDING, type AutoOffboardGraph, type OffboardLookup } from './graph-agents'
import type { TelemetryClient } from './telemetry'

const MAX_EVENT_BUFFER = 5000
const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'agent-flow')
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects')

let relayCreated = false
let verbose = false
let sessionEventCount = 0
/** Distinct model IDs seen across all watched sessions during this relay session.
 *  Populated from `model_detected` events (emitted by both the Claude transcript
 *  parser and the Codex rollout parser). Read at session_end for telemetry. */
const observedModels = new Set<string>()

// agent-flow-app version. Inlined by esbuild at bundle time via `define`.
// In dev (running from source via tsx), falls back to reading app/package.json.
declare const AGENT_FLOW_APP_VERSION: string | undefined
function resolveAgentFlowVersion(): string {
  try {
    if (typeof AGENT_FLOW_APP_VERSION === 'string' && AGENT_FLOW_APP_VERSION) {
      return AGENT_FLOW_APP_VERSION
    }
  } catch { /* ReferenceError in unbundled dev — fall through */ }
  try {
    const pkgPath = path.join(__dirname, '..', 'app', 'package.json')
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0'
    }
  } catch { /* ignore */ }
  return '0.0.0'
}

function log(...args: unknown[]) {
  if (verbose) console.log(...args)
}

// ─── SSE client management ──────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>()

/** JSON text of `data`, or null when it cannot be serialised (cycle, BigInt, nesting too deep): never thrown. */
function serialize(data: unknown): string | null {
  try {
    const text = JSON.stringify(data)
    return typeof text === 'string' ? text : null
  } catch (e) {
    log('[relay] message not serialisable, left out:', (e as Error)?.message)
    return null
  }
}

/** Send one message to one client. A message that cannot be serialised is skipped; only a failed write drops the
 *  client. */
function sendSSE(res: http.ServerResponse, data: unknown) {
  const text = serialize(data)
  if (text === null) return
  writeSSE(res, text)
}

function writeSSE(res: http.ServerResponse, text: string) {
  try { res.write(`data: ${text}\n\n`) } catch {
    sseClients.delete(res)
  }
}

function broadcast(data: string) {
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`) } catch {
      sseClients.delete(res)
    }
  }
}

// ─── Event buffering ────────────────────────────────────────────────────────

const eventBuffer = new Map<string, AgentEvent[]>()

/** Agents per session, and the offboard lookup that hides finished, offboarded ones (spec offboard-names item 1). */
const graphAgents = new GraphAgents()
let offboardLookup: OffboardLookup = NO_OFFBOARDING

/** When a sub-agent finished: its transcript's last write (right for agents rebuilt after a restart), else now. */
function subagentFinishedAt(event: AgentEvent): number | undefined {
  if (event.type !== 'agent_complete' || !event.sessionId) return undefined
  const session = sessions.get(event.sessionId)
  const name = event.payload?.name
  if (!session || typeof name !== 'string') return undefined
  for (const [filePath, state] of session.subagentWatchers) {
    if (state.agentName !== name) continue
    try { return fs.statSync(filePath).mtimeMs } catch { return undefined }
  }
  return undefined
}

function broadcastEvent(event: AgentEvent) {
  sessionEventCount++
  if (event.type === 'model_detected') {
    const m = (event.payload as { model?: unknown } | undefined)?.model
    if (typeof m === 'string' && m.length > 0) observedModels.add(m)
  }
  const sid = event.sessionId?.slice(0, SESSION_ID_DISPLAY) || '?'
  const cloudSource = event.sessionId ? cloudSessions.get(event.sessionId)?.sourceId : undefined
  // A cloud source decides how many events it sends: its lines are limited (one per source per minute).
  if (cloudSource === undefined) log(`[event] ${event.type} (session ${sid})`)
  else if (verbose) cloudLog.line('cloud-event', cloudSource, `[event] ${event.type} (session ${sid}, cloud ${cloudSource})`)

  const now = Date.now()
  const finishedAt = event.type === 'agent_complete' ? (subagentFinishedAt(event) ?? now) : undefined
  // A sub-agent's completion carries finishedAt / autoOffboardAt (spec ui-cleanup item 6); buffered with them, so a
  // replay has them too.
  if (finishedAt !== undefined) event = graphAgents.annotateCompletion(event, finishedAt, autoOffboardMs)

  // Serialised before it is buffered: an event that cannot be serialised never enters a buffer (a buffered one
  // would break the replay of every later client).
  const data = serialize({ type: 'agent-event', event })
  if (data === null) return

  if (event.sessionId) bufferEvent(event.sessionId, event, Buffer.byteLength(data))

  const { send, hide } = graphAgents.admit(event, offboardLookup, now, finishedAt)
  if (send) broadcast(data)
  if (hide.length && event.sessionId) announceOffboarded(event.sessionId, hide)
  if ((event.type === 'agent_spawn' || event.type === 'agent_complete') && event.payload?.isMain !== true
    && event.payload?.name !== ORCHESTRATOR_NAME) {
    for (const fn of [...agentsChangedListeners]) { try { fn() } catch (e) { log('[relay] agents listener failed:', e) } }
  }
}

/**
 * Buffer one event for the replay. Every buffer keeps at most MAX_EVENT_BUFFER events; a cloud session's buffer is
 * also capped in bytes, per session, per source and across all cloud sessions (trimCloudBuffers, trimCloudTotal).
 */
function bufferEvent(sessionId: string, event: AgentEvent, bytes: number) {
  let buf = eventBuffer.get(sessionId) || []
  buf.push(event)
  const cloud = cloudSessions.get(sessionId)
  const sized = cloud ? cloudBufferOf(sessionId) : null
  if (sized) {
    sized.sizes.push({ bytes, n: ++cloudBufferSeq })
    sized.total += bytes
    cloudTotalBytes += bytes
  }
  if (buf.length > MAX_EVENT_BUFFER) {
    const cut = buf.length - MAX_EVENT_BUFFER
    buf = buf.slice(cut)
    if (sized) for (const s of sized.sizes.splice(0, cut)) { sized.total -= s.bytes; cloudTotalBytes -= s.bytes }
  }
  eventBuffer.set(sessionId, buf)
  if (cloud) {
    trimCloudBuffers(cloud)
    trimCloudTotal(cloud.id)
  }
}

/** Auto offboarding (spec ui-cleanup item 6): the interval, and who hears about sub-agent spawns and completions. */
let autoOffboardMs: number | undefined
const agentsChangedListeners = new Set<() => void>()

function announceOffboarded(sessionId: string, agents: string[]) {
  broadcast(JSON.stringify({ type: 'agents-offboarded', sessionId, agents }))
}

/** Main-agent spawn payload; carries the project's coordinator instance when state.json names one. */
function mainSpawn(session: WatchedSession): Record<string, unknown> {
  return mainSpawnPayload(ORCHESTRATOR_NAME, session.label, session.model, sessionProjects.get(session.sessionId)?.coordinator)
}

/** Project of each watched Claude session (spec graph-theme items 3-4). Codex sessions are not in here. */
const sessionProjects = new Map<string, WatchedProject>()

/** What a viewer reads for a session: its project title or folder name. The first prompt is kept as `prompt`. */
function sessionView(sessionId: string, fallbackLabel: string): { label: string; projectId?: string; prompt?: string; coordinator?: CoordinatorInfo } {
  const project = sessionProjects.get(sessionId)
  if (!project) return { label: fallbackLabel }
  return {
    label: projectSessionLabel(project), projectId: project.id || undefined, prompt: sessions.get(sessionId)?.label,
    ...(project.coordinator ? { coordinator: { ...project.coordinator } } : {}),
  }
}

function broadcastSessionLifecycle(type: 'started' | 'ended' | 'updated', sessionId: string, label: string) {
  if (type === 'started') {
    broadcast(JSON.stringify({
      type: 'session-started',
      session: { id: sessionId, ...sessionView(sessionId, label), status: 'active', startTime: Date.now(), lastActivityTime: Date.now() } as SessionInfo,
    }))
  } else if (type === 'ended') {
    broadcast(JSON.stringify({ type: 'session-ended', sessionId }))
  } else if (type === 'updated') {
    broadcast(JSON.stringify({ type: 'session-updated', sessionId, ...sessionView(sessionId, label) }))
  }
}

// ─── Session watcher ────────────────────────────────────────────────────────

const sessions = new Map<string, WatchedSession>()

function elapsed(sessionId?: string): number {
  if (sessionId) {
    const session = sessions.get(sessionId)
    if (session) return (Date.now() - session.sessionStartTime) / 1000
  }
  return 0
}

function emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string) {
  const bd = session.contextBreakdown
  const total = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
  broadcastEvent({
    time: elapsed(sessionId),
    type: 'context_update',
    payload: { agent: agentName, tokens: total, breakdown: { ...bd } },
    sessionId,
  })
}

function emitEvent(event: AgentEvent, sessionId?: string) {
  broadcastEvent(sessionId ? { ...event, sessionId } : event)
}

const parser = new TranscriptParser({
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  fireSessionLifecycle: (event) => broadcastSessionLifecycle(event.type, event.sessionId, event.label),
  emitContextUpdate,
  scanSubagents: (sessionId: string) => scanSubagentsDir(watcherDelegate, parser, sessionId),
})

const watcherDelegate = {
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  getLastActivityTime: (sessionId: string) => sessions.get(sessionId)?.lastActivityTime,
  resetInactivityTimer: (sessionId: string) => resetInactivityTimer(sessionId),
}

function resetInactivityTimer(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const wasCompleted = session.sessionCompleted
  session.lastActivityTime = Date.now()
  session.sessionCompleted = false

  if (wasCompleted) {
    broadcastEvent({
      time: elapsed(sessionId),
      type: 'agent_spawn',
      payload: mainSpawn(session),
      sessionId,
    })
    broadcastSessionLifecycle('started', sessionId, session.label)
  }

  if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
  session.inactivityTimer = setTimeout(() => {
    if (!session.sessionCompleted && session.sessionDetected) {
      log(`[session] ${sessionId.slice(0, SESSION_ID_DISPLAY)} inactive`)
      session.sessionCompleted = true
      finishRunningSubagents(session)
      broadcastEvent({
        time: elapsed(sessionId),
        type: 'agent_complete',
        payload: { name: ORCHESTRATOR_NAME },
        sessionId,
      })
      broadcastSessionLifecycle('ended', sessionId, session.label)
    }
  }, INACTIVITY_TIMEOUT_MS)
}

/**
 * A session that ended (no transcript writes, its sub-agents' included, for INACTIVITY_TIMEOUT_MS) finishes every
 * sub-agent still running on the graph: each gets an `agent_complete` with `sessionEnded: true` (and, like every
 * sub-agent completion, `finished`/`finishedAt`/`autoOffboardAt`; finishedAt = its transcript's last write). So the
 * server, the Offboard endpoints, auto offboarding and the UI agree on "finished". Its watcher is marked completed,
 * so a new write to its transcript revives it with a fresh spawn (a resume), which also resets its clock.
 */
function finishRunningSubagents(session: WatchedSession) {
  for (const name of graphAgents.runningSubagents(session.sessionId)) {
    for (const state of session.subagentWatchers.values()) {
      if (state.agentName === name) state.completed = true
    }
    broadcastEvent({
      time: elapsed(session.sessionId),
      type: 'agent_complete',
      payload: { name, sessionEnded: true },
      sessionId: session.sessionId,
    })
  }
}

function watchSession(sessionId: string, filePath: string) {
  const defaultLabel = `Session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`
  const session: WatchedSession = {
    sessionId, filePath,
    fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    seenMessageHashes: new Set(),
    sessionDetected: false, sessionCompleted: false,
    lastActivityTime: Date.now(),
    inactivityTimer: null,
    subagentWatchers: new Map(),
    spawnedSubagents: new Set(),
    inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null,
    label: defaultLabel, labelSet: false,
    model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: SYSTEM_PROMPT_BASE_TOKENS, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
  sessions.set(sessionId, session)

  const stat = fs.statSync(filePath)
  const catchUpEntries = parser.prescanExistingContent(filePath, stat.size, session)
  session.fileSize = stat.size
  parser.extractSessionLabel(catchUpEntries, session)

  broadcastSessionLifecycle('started', sessionId, session.label)
  broadcastEvent({
    time: 0, type: 'agent_spawn',
    payload: mainSpawn(session),
    sessionId,
  })
  session.sessionDetected = true

  emitContextUpdate(ORCHESTRATOR_NAME, session, sessionId)
  parser.emitCatchUpEntries(catchUpEntries, session, sessionId)

  const watchTranscript = () => fs.watch(session.filePath, (eventType) => {
    if (eventType === 'change') readNewLines(sessionId)
  })
  session.fileWatcher = watchTranscript()

  session.pollTimer = setInterval(() => {
    // Entering a worktree moves the transcript to another project folder
    if (followSession(watcherDelegate, parser, session, CLAUDE_DIR)) {
      log(`[session] ${sessionId.slice(0, SESSION_ID_DISPLAY)} moved to ${session.filePath}`)
      session.fileWatcher?.close()
      try { session.fileWatcher = watchTranscript() } catch {}
    }
    readNewLines(sessionId)
    for (const [subPath] of session.subagentWatchers) {
      readSubagentNewLines(watcherDelegate, parser, subPath, sessionId)
    }
    scanSubagentsDir(watcherDelegate, parser, sessionId)
  }, POLL_FALLBACK_MS)

  session.subagentsDir = path.join(path.dirname(filePath), sessionId, 'subagents')
  // Every subagent already on disk gets its node (finished ones dimmed), so a
  // server restart or a late page load shows the whole team, not just the Orchestrator.
  rebuildSubagentsOnAttach(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)

  log(`[session] Watching ${sessionId.slice(0, SESSION_ID_DISPLAY)} — "${session.label}"`)
}

function readNewLines(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const result = readNewFileLines(session.filePath, session.fileSize, session.fileTail)
  if (!result) return
  session.fileSize = result.newSize
  session.fileTail = result.tail
  for (const line of result.lines) {
    parser.processTranscriptLine(line, ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, sessionId, session.seenMessageHashes)
  }

  handlePermissionDetection(watcherDelegate, ORCHESTRATOR_NAME, session.pendingToolCalls, session, sessionId, session.sessionCompleted, true)
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)
}

// ─── Session scanner ────────────────────────────────────────────────────────

/** Folders under ~/.claude/projects being watched for new transcripts, and where the current targets come from. */
const projectDirWatchers = new Map<string, fs.FSWatcher>()
let currentTargets: () => WatchedProject[] = () => []

function watchProjectDir(dirPath: string) {
  if (projectDirWatchers.has(dirPath)) return
  try {
    projectDirWatchers.set(dirPath, fs.watch(dirPath, (_eventType, filename) => {
      if (filename?.endsWith('.jsonl')) scanForActiveSessions(currentTargets())
    }))
  } catch { /* the periodic scan still finds new sessions */ }
}

/**
 * Watch every recent session whose folder is one of the targets (the registered projects, or the start folder
 * when none are registered). Also refreshes the labels of watched sessions when a project title changed.
 */
function scanForActiveSessions(targets: WatchedProject[]) {
  for (const [sessionId, old] of sessionProjects) {
    const now = targets.find((t) => t.path === old.path)
    if (now && (projectSessionLabel(now) !== projectSessionLabel(old) || !sameCoordinator(now.coordinator, old.coordinator))) {
      sessionProjects.set(sessionId, now)
      broadcastSessionLifecycle('updated', sessionId, sessions.get(sessionId)?.label ?? '')
    }
  }

  if (!fs.existsSync(CLAUDE_DIR)) return

  // Case-folded inside matchProjectDir: VS Code/shells on Windows report `c:\...` while Claude Code encodes `C--...`.
  const dirsToScan: Array<{ dirPath: string; project: WatchedProject }> = []
  try {
    for (const dir of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const project = matchProjectDir(dir.name, targets)
      if (project) dirsToScan.push({ dirPath: path.join(CLAUDE_DIR, dir.name), project })
    }
  } catch { /* readdir failed; try again on the next scan */ }

  for (const { dirPath, project } of dirsToScan) {
    watchProjectDir(dirPath)
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue
        const filePath = path.join(dirPath, file)
        const stat = fs.statSync(filePath)
        const sessionId = path.basename(file, '.jsonl')

        // Subagent writes (including nested workflows/wf_*/ files) keep a
        // session alive when the main JSONL is stale. Only walk the tree when
        // the main file alone doesn't qualify.
        let newestMtime = stat.mtimeMs
        if ((Date.now() - newestMtime) / 1000 > ACTIVE_SESSION_AGE_S) {
          const subMtime = newestSubagentMtime(path.join(dirPath, sessionId, 'subagents'))
          if (subMtime > newestMtime) newestMtime = subMtime
        }

        const ageSeconds = (Date.now() - newestMtime) / 1000
        if (ageSeconds <= ACTIVE_SESSION_AGE_S && !sessions.has(sessionId)) {
          sessionProjects.set(sessionId, project)
          watchSession(sessionId, filePath)
        }
      }
    } catch {}
  }
}

// ─── Cloud sessions (hub intake, `--ingest`) ────────────────────────────────

/**
 * A session received from a cloud container (a "source") through the hub intake. Its events go through the same
 * buffer, offboarding and auto offboarding as a local session's; it is never watched on disk here.
 */
interface CloudSession {
  id: string
  sourceId: string
  /** Hub registry id of the source's mirrored project. */
  projectId: string
  label: string
  prompt?: string
  coordinator?: CoordinatorInfo
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  /** Retired (spec 0.9.8 item 2): ended, its sub-agents finished and `session-removed` sent. Kept for the offboard
   *  endpoints and auto offboarding, but left out of the session list and the replay. Cleared when its source sends
   *  anything about it again (the session is announced afresh then). */
  retired?: boolean
}

/** Messages the intake hands over, already shape-checked and capped by the caller (app/src/team/ingest.ts). */
export type CloudMessage =
  | { type: 'session-started'; session: { id: string; label: string; status: 'active' | 'completed'; startTime: number; lastActivityTime: number; prompt?: string; coordinator?: CoordinatorInfo } }
  | { type: 'session-updated'; sessionId: string; label: string; prompt?: string; coordinator?: CoordinatorInfo }
  | { type: 'session-ended'; sessionId: string }
  | { type: 'agent-event'; event: AgentEvent & { sessionId: string } }
  | { type: 'agent-event-batch'; events: Array<AgentEvent & { sessionId: string }> }

/** Upper bound on cloud sessions kept in memory (each keeps up to MAX_EVENT_BUFFER events). At the cap, ended
 *  sessions and sessions of stale sources are evicted to make room (makeCloudRoom). */
export const MAX_CLOUD_SESSIONS = 200
/** Bytes of buffered events (as sent on /events) kept per cloud session and per source; oldest dropped first. */
export const MAX_CLOUD_SESSION_BUFFER_BYTES = 4 * 1024 * 1024
export const MAX_CLOUD_SOURCE_BUFFER_BYTES = 16 * 1024 * 1024
/** Bytes of buffered events of all cloud sessions together (hub-wide); see trimCloudTotal for what goes first. */
export const MAX_CLOUD_TOTAL_BUFFER_BYTES = 128 * 1024 * 1024
/** Bytes of cloud events one new /events client gets in its replay (the newest first, per session). */
export const MAX_CLOUD_REPLAY_BYTES = 32 * 1024 * 1024

export interface CloudLimits {
  maxSessions: number
  sessionBufferBytes: number
  sourceBufferBytes: number
  totalBufferBytes: number
  replayBytes: number
}

const DEFAULT_CLOUD_LIMITS: CloudLimits = {
  maxSessions: MAX_CLOUD_SESSIONS,
  sessionBufferBytes: MAX_CLOUD_SESSION_BUFFER_BYTES,
  sourceBufferBytes: MAX_CLOUD_SOURCE_BUFFER_BYTES,
  totalBufferBytes: MAX_CLOUD_TOTAL_BUFFER_BYTES,
  replayBytes: MAX_CLOUD_REPLAY_BYTES,
}
let cloudLimits: CloudLimits = { ...DEFAULT_CLOUD_LIMITS }

const cloudSessions = new Map<string, CloudSession>()
/** Verbose lines caused by cloud sources (scripts/log-limit.ts): one per kind and source per minute. */
const cloudLog = new LogLimiter((line) => log(line))
const staleSources = new Set<string>()
/** When each stale source became stale (eviction order: stale longest first). */
const staleSince = new Map<string, number>()

/** Sizes of a cloud session's buffered events (parallel to eventBuffer), with a global arrival number each. */
interface CloudBuffer { sizes: Array<{ bytes: number; n: number }>; total: number }
const cloudBuffers = new Map<string, CloudBuffer>()
let cloudBufferSeq = 0
/** Sum of `total` over every entry of cloudBuffers (kept exact by every add, drop and eviction). */
let cloudTotalBytes = 0

function cloudBufferOf(sessionId: string): CloudBuffer {
  let b = cloudBuffers.get(sessionId)
  if (!b) { b = { sizes: [], total: 0 }; cloudBuffers.set(sessionId, b) }
  return b
}

/** Drop the oldest buffered event of a cloud session. */
function dropOldestCloudEvent(sessionId: string): void {
  const buf = eventBuffer.get(sessionId)
  const sized = cloudBuffers.get(sessionId)
  if (!buf || !sized || !sized.sizes.length) return
  buf.shift()
  const bytes = sized.sizes.shift()!.bytes
  sized.total -= bytes
  cloudTotalBytes -= bytes
}

/**
 * Keep the buffers of all cloud sessions together under the hub-wide cap (totalBufferBytes). Oldest events go first
 * from sessions of stale sources, then from ended sessions, then from the largest live session buffers. The event
 * just buffered for `keep` is never dropped, so a live source's new event is never refused because of other data.
 */
function trimCloudTotal(keep: string): void {
  const over = () => cloudTotalBytes > cloudLimits.totalBufferBytes
  if (!over()) return
  const head = (id: string) => {
    const b = cloudBuffers.get(id)
    return b && b.sizes.length > (id === keep ? 1 : 0) ? b : null
  }
  const all = [...cloudSessions.values()]
  const groups = [
    all.filter((s) => staleSources.has(s.sourceId)),
    all.filter((s) => !staleSources.has(s.sourceId) && s.status === 'completed'),
  ]
  for (const group of groups) {
    while (over()) {
      let oldest: string | null = null
      let oldestN = Infinity
      for (const s of group) {
        const b = head(s.id)
        if (b && b.sizes[0].n < oldestN) { oldestN = b.sizes[0].n; oldest = s.id }
      }
      if (oldest === null) break
      dropOldestCloudEvent(oldest)
    }
  }
  while (over()) {
    let largest: string | null = null
    let largestBytes = -1
    for (const s of all) {
      const b = head(s.id)
      if (b && b.total > largestBytes) { largestBytes = b.total; largest = s.id }
    }
    if (largest === null) break
    dropOldestCloudEvent(largest)
  }
}

/** Buffered bytes of cloud sessions: the running total, the same recounted from every event, and per session (for
 *  tests and diagnostics). */
export function cloudBufferStats(): { total: number; recounted: number; sessions: Record<string, { bytes: number; events: number }> } {
  const sessionsOut: Record<string, { bytes: number; events: number }> = {}
  let recounted = 0
  for (const [id, b] of cloudBuffers) {
    const bytes = b.sizes.reduce((s, e) => s + e.bytes, 0)
    recounted += bytes
    sessionsOut[id] = { bytes, events: eventBuffer.get(id)?.length ?? 0 }
  }
  return { total: cloudTotalBytes, recounted, sessions: sessionsOut }
}

/** Keep a cloud session's buffer, and its source's buffers together, under their byte caps (oldest first). */
function trimCloudBuffers(s: CloudSession): void {
  const own = cloudBuffers.get(s.id)
  while (own && own.total > cloudLimits.sessionBufferBytes && own.sizes.length) dropOldestCloudEvent(s.id)
  const ids = [...cloudSessions.values()].filter((c) => c.sourceId === s.sourceId).map((c) => c.id)
  let total = 0
  for (const id of ids) total += cloudBuffers.get(id)?.total ?? 0
  while (total > cloudLimits.sourceBufferBytes) {
    let oldest: string | null = null
    let oldestN = Infinity
    for (const id of ids) {
      const head = cloudBuffers.get(id)?.sizes[0]
      if (head && head.n < oldestN) { oldestN = head.n; oldest = id }
    }
    if (oldest === null) break
    const bytes = cloudBuffers.get(oldest)!.sizes[0].bytes
    dropOldestCloudEvent(oldest)
    total -= bytes
  }
}

/** `time` of the last buffered event of a session (hub-made events keep the session's clock), else 0. */
function lastEventTime(sessionId: string): number {
  const buf = eventBuffer.get(sessionId)
  const t = buf && buf.length ? buf[buf.length - 1].time : 0
  return typeof t === 'number' && Number.isFinite(t) ? t : 0
}

/** Finish one sub-agent of a cloud session on the hub: an `agent_complete` like a received one (finishedAt and
 *  autoOffboardAt added by broadcastEvent). `sessionEnded`: finished because its session or container ended. */
function finishCloudAgent(s: CloudSession, name: string, sessionEnded: boolean): void {
  broadcastEvent({
    time: lastEventTime(s.id), type: 'agent_complete',
    payload: sessionEnded ? { name, sessionEnded: true } : { name },
    sessionId: s.id,
  })
}

/**
 * The cloud counterpart of finishRunningSubagents (spec 0.9.8 item 3): every sub-agent of the session still running
 * on the graph gets an `agent_complete` with `sessionEnded: true`, so the offboard endpoints, auto offboarding and
 * the UI see it finished. Returns how many were finished.
 */
function finishCloudSubagents(s: CloudSession): number {
  const names = graphAgents.runningSubagents(s.id)
  for (const name of names) finishCloudAgent(s, name, true)
  return names.length
}

/**
 * Retire a cloud session (spec 0.9.8 items 2, 3, 5): its running sub-agents are finished, it ends (`session-ended`
 * when it was active) and viewers get `session-removed`. It stays known to the graph (offboarding, auto offboarding)
 * but no longer appears in the session list or the replay. Nothing is sent for one retired already.
 */
function retireCloudSession(s: CloudSession): boolean {
  if (s.retired) return false
  finishCloudSubagents(s)
  if (s.status === 'active') {
    s.status = 'completed'
    broadcast(JSON.stringify({ type: 'session-ended', sessionId: s.id }))
  }
  s.retired = true
  broadcast(JSON.stringify({ type: 'session-removed', sessionId: s.id }))
  return true
}

/** Retire every session of a source (a newer source of the same project went live). Returns how many. */
function retireCloudSource(sourceId: string): number {
  let n = 0
  for (const s of [...cloudSessions.values()]) if (s.sourceId === sourceId && retireCloudSession(s)) n++
  return n
}

/** Finish the running sub-agents of every session of a source (stale longer than CLOUD_RETIRE_AFTER_MS). */
function finishCloudSource(sourceId: string): number {
  let n = 0
  for (const s of [...cloudSessions.values()]) if (s.sourceId === sourceId) n += finishCloudSubagents(s)
  return n
}

/**
 * Remove a cloud session with its buffer and agents. Like a retirement first (spec 0.9.8 items 3 and 5): running
 * sub-agents finished, `session-ended` if it was still active, then `session-removed` (unless it was retired
 * already, which sent both).
 */
function evictCloudSession(s: CloudSession): void {
  retireCloudSession(s)
  cloudSessions.delete(s.id)
  eventBuffer.delete(s.id)
  cloudTotalBytes -= cloudBuffers.get(s.id)?.total ?? 0
  cloudBuffers.delete(s.id)
  graphAgents.forget(s.id)
  if (verbose) cloudLog.line('cloud-evict', s.sourceId, `[cloud] evicted session ${s.id.slice(0, SESSION_ID_DISPLAY)} of ${s.sourceId}`)
}

/**
 * Room for the new cloud sessions among `sessionIds` (ids not known yet). At the cap, sessions are evicted in this
 * order: ended sessions of stale sources, other sessions of stale sources (stale longest first), then ended sessions
 * of live sources (least recently active first). An active session of a live source is never evicted. False when
 * there is not enough room even so (nothing is evicted then).
 */
function makeCloudRoom(sessionIds: string[], leaving?: string): boolean {
  const fresh = new Set(sessionIds.filter((id) => !sessions.has(id) && !cloudSessions.has(id)))
  // The sessions of a source about to be removed for this request (`leaving`) are room already.
  let goingAway = 0
  if (leaving !== undefined) for (const s of cloudSessions.values()) if (s.sourceId === leaving) goingAway++
  const need = cloudSessions.size - goingAway + fresh.size - cloudLimits.maxSessions
  if (need <= 0) return true
  // Retired sessions (no longer listed anywhere) go first.
  const rank = (s: CloudSession) => (s.retired ? -1 : staleSources.has(s.sourceId) ? (s.status === 'completed' ? 0 : 1) : 2)
  const candidates = [...cloudSessions.values()]
    .filter((s) => s.sourceId !== leaving && (s.status === 'completed' || staleSources.has(s.sourceId)))
    .sort((a, b) => rank(a) - rank(b)
      || (staleSince.get(a.sourceId) ?? 0) - (staleSince.get(b.sourceId) ?? 0)
      || a.lastActivityTime - b.lastActivityTime)
  if (candidates.length < need) return false
  for (const s of candidates.slice(0, need)) evictCloudSession(s)
  return true
}

/** Forget every session of a source (the hub removed the source). */
function forgetCloudSource(sourceId: string): void {
  for (const s of [...cloudSessions.values()]) if (s.sourceId === sourceId) evictCloudSession(s)
  staleSources.delete(sourceId)
  staleSince.delete(sourceId)
}

function cloudView(s: CloudSession): SessionInfo {
  return {
    id: s.id, label: s.label, status: s.status, startTime: s.startTime, lastActivityTime: s.lastActivityTime,
    projectId: s.projectId,
    ...(s.prompt !== undefined ? { prompt: s.prompt } : {}),
    ...(s.coordinator ? { coordinator: { ...s.coordinator } } : {}),
    origin: 'cloud', sourceId: s.sourceId, stale: staleSources.has(s.sourceId),
  }
}

function broadcastCloudUpdated(s: CloudSession) {
  const { id, status: _status, startTime: _start, lastActivityTime: _last, ...rest } = cloudView(s)
  broadcast(JSON.stringify({ type: 'session-updated', sessionId: id, ...rest }))
}

/**
 * The cloud session `sessionId` of `sourceId`, created (and announced) on first sight. Null when the id belongs to
 * a local session or to another source, or when the cap is reached: such messages are dropped.
 */
function claimCloudSession(sessionId: string, sourceId: string, projectId: string, now: number): CloudSession | null {
  if (sessions.has(sessionId)) return null
  const existing = cloudSessions.get(sessionId)
  if (existing) return existing.sourceId === sourceId ? existing : null
  if (cloudSessions.size >= cloudLimits.maxSessions) return null
  // A leftover buffer under this id (not a cloud one, so not counted in bytes) would no longer match its sizes.
  if (!cloudBuffers.has(sessionId)) eventBuffer.delete(sessionId)
  const s: CloudSession = {
    id: sessionId, sourceId, projectId, label: `Session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`,
    status: 'active', startTime: now, lastActivityTime: now,
  }
  cloudSessions.set(sessionId, s)
  return s
}

/** Apply one source's messages in order. Returns how many were applied and how many were dropped. */
function applyCloudMessages(sourceId: string, projectId: string, messages: CloudMessage[]): { applied: number; ignored: number } {
  let applied = 0
  let ignored = 0
  // A retired session its source talks about again is back: announced afresh (session-started), like a new one.
  const fresh = (id: string) => !cloudSessions.has(id) || cloudSessions.get(id)!.retired === true
  const revive = (s: CloudSession) => { if (s.retired) s.retired = false }
  for (const m of messages) {
    const now = Date.now()
    if (m.type === 'session-started') {
      const isNew = !cloudSessions.has(m.session.id)
      const s = claimCloudSession(m.session.id, sourceId, projectId, now)
      if (!s) { ignored++; continue }
      revive(s)
      s.label = m.session.label
      s.prompt = m.session.prompt
      s.coordinator = m.session.coordinator
      s.status = m.session.status
      if (isNew) s.startTime = m.session.startTime
      s.lastActivityTime = now
      broadcast(JSON.stringify({ type: 'session-started', session: cloudView(s) }))
      applied++
    } else if (m.type === 'session-updated') {
      const isNew = fresh(m.sessionId)
      const s = claimCloudSession(m.sessionId, sourceId, projectId, now)
      if (!s) { ignored++; continue }
      revive(s)
      s.label = m.label
      s.prompt = m.prompt
      s.coordinator = m.coordinator
      if (isNew) broadcast(JSON.stringify({ type: 'session-started', session: cloudView(s) }))
      else broadcastCloudUpdated(s)
      applied++
    } else if (m.type === 'session-ended') {
      const s = cloudSessions.get(m.sessionId)
      if (!s || s.sourceId !== sourceId) { ignored++; continue }
      s.status = 'completed'
      // A retired session ended already as far as viewers know; it stays removed.
      if (!s.retired) broadcast(JSON.stringify({ type: 'session-ended', sessionId: s.id }))
      applied++
    } else {
      const events = m.type === 'agent-event' ? [m.event] : m.events
      for (const event of events) {
        const isNew = fresh(event.sessionId)
        const s = claimCloudSession(event.sessionId, sourceId, projectId, now)
        if (!s) { ignored++; continue }
        revive(s)
        // A session that was only seen through its events (e.g. the hub restarted) is announced first.
        if (isNew) broadcast(JSON.stringify({ type: 'session-started', session: cloudView(s) }))
        s.lastActivityTime = now
        broadcastEvent(event)
        applied++
      }
    }
  }
  return { applied, ignored }
}

function setCloudSourceStale(sourceId: string, stale: boolean): void {
  if (staleSources.has(sourceId) === stale) return
  if (stale) { staleSources.add(sourceId); staleSince.set(sourceId, Date.now()) }
  else { staleSources.delete(sourceId); staleSince.delete(sourceId) }
  for (const s of cloudSessions.values()) if (s.sourceId === sourceId && !s.retired) broadcastCloudUpdated(s)
}

/** The source now belongs to another hub project (it reported another project id). */
function moveCloudSource(sourceId: string, projectId: string): void {
  for (const s of cloudSessions.values()) {
    if (s.sourceId !== sourceId || s.projectId === projectId) continue
    s.projectId = projectId
    if (!s.retired) broadcastCloudUpdated(s)
  }
}

/** Finish a running sub-agent of a cloud session (true when it was running and is finished now). `orphanedOnly`:
 *  only when its source is stale or the session retired (its container no longer reports). */
function finishCloudAgentIfRunning(sessionId: string, name: string, orphanedOnly: boolean): boolean {
  const s = cloudSessions.get(sessionId)
  if (!s) return false
  const orphaned = staleSources.has(s.sourceId) || s.retired === true
  if (orphanedOnly && !orphaned) return false
  const agent = graphAgents.agent(sessionId, name)
  if (!agent || agent.isMain || agent.status !== 'running') return false
  finishCloudAgent(s, name, orphaned)
  return true
}

// ─── Discovery file ─────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  let resolved = path.resolve(p)
  try { resolved = fs.realpathSync(resolved) } catch {}
  return resolved
}

function hashWorkspace(workspace: string): string {
  return crypto.createHash('sha256').update(normalizePath(workspace)).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}

let discoveryFilePath: string | null = null

function writeDiscoveryFile(port: number, workspace: string) {
  if (!fs.existsSync(DISCOVERY_DIR)) fs.mkdirSync(DISCOVERY_DIR, { recursive: true })
  const hash = hashWorkspace(workspace)
  discoveryFilePath = path.join(DISCOVERY_DIR, `${hash}-${process.pid}.json`)
  fs.writeFileSync(discoveryFilePath, JSON.stringify({ port, pid: process.pid, workspace: normalizePath(workspace) }, null, 2) + '\n')
}

function removeDiscoveryFile() {
  if (discoveryFilePath) {
    try { fs.unlinkSync(discoveryFilePath) } catch {}
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface Relay {
  /** Handle an incoming SSE connection */
  handleSSE: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** Agents per Claude session, for the offboard endpoints (spec offboard-names item 1) and auto offboarding. */
  graph: AutoOffboardGraph
  /** Hub intake (`--ingest`): sessions received from cloud containers. */
  cloud: CloudIntake
  /** Clean up all resources */
  dispose: () => void
}

/** What the hub intake (app/src/team/ingest.ts) uses to put cloud sessions on the graph. */
export interface CloudIntake {
  /** Feed one source's relay messages, in order. Messages about a local session or another source's are dropped. */
  apply(sourceId: string, projectId: string, messages: CloudMessage[]): { applied: number; ignored: number }
  /** Mark a source stale (or live again): its sessions get a `session-updated` with the new `stale`. */
  setStale(sourceId: string, stale: boolean): void
  /** The source a cloud session came from, or null (local or unknown session). */
  sourceOf(sessionId: string): string | null
  /** Make room for the sessions among `sessionIds` that are new (evicting ended or stale ones at the cap). False
   *  when not enough sessions can be evicted (nothing is evicted then): the caller refuses the request. `leaving`:
   *  a source the caller removes right after, whose sessions count as room. */
  makeRoom(sessionIds: string[], leaving?: string): boolean
  /** Forget every session (and buffer) of a source the hub removed. Each one is retired first (sub-agents finished,
   *  `session-ended`, `session-removed`). */
  forgetSource(sourceId: string): void
  /** Retire every session of a source (spec 0.9.8 item 2): running sub-agents finished, `session-ended`, then
   *  `session-removed`; left out of the session list and replay from then on. Returns how many were retired. */
  retireSource(sourceId: string): number
  /** Finish the running sub-agents of every session of a source (spec 0.9.8 item 3). Returns how many. */
  finishSource(sourceId: string): number
  /** Finish one running sub-agent of a cloud session (spec 0.9.8 item 4); false when it is not running there. */
  finishAgent(sessionId: string, agent: string): boolean
  /** The source's sessions now belong to hub project `projectId` (it reported another project id). */
  moveSource(sourceId: string, projectId: string): void
  /** Tell open graph streams that GET /api/team/projects changed (`projects-changed`). */
  announceProjectsChanged(): void
}

export type RelayRuntimeMode = 'claude' | 'codex' | 'auto'

export interface RelayOptions {
  workspace: string
  verbose?: boolean
  telemetry?: TelemetryClient
  /** Which runtimes to watch. Defaults to AGENT_FLOW_RUNTIME env var, or 'auto'.
   *  Mirrors the extension's `agentVisualizer.runtime` setting so users of the
   *  dev relay and `npx agent-flow-app` have a way to opt out of one runtime. */
  runtime?: RelayRuntimeMode
  /** Registered team projects (read on every scan). When it returns any, the graph shows the sessions of all of
   *  them instead of only the start folder's (spec graph-theme item 3). */
  projects?: () => WatchedProject[]
  /** Offboarded agents (standalone app): their events are left out of the graph stream while they are not running. */
  offboarded?: OffboardLookup
  /** Auto offboard interval (spec ui-cleanup item 6): a sub-agent's `agent_complete` then carries `autoOffboardAt`.
   *  The offboarding itself is done by the app's AutoOffboarder through `graph`. */
  autoOffboardMinutes?: number
  /** Hub intake limits (defaults: MAX_CLOUD_* above); smaller values for tests. */
  cloudLimits?: Partial<CloudLimits>
}

function resolveRuntimeMode(explicit?: RelayRuntimeMode): RelayRuntimeMode {
  if (explicit === 'claude' || explicit === 'codex' || explicit === 'auto') return explicit
  const raw = process.env.AGENT_FLOW_RUNTIME
  return raw === 'claude' || raw === 'codex' ? raw : 'auto'
}

export async function createRelay(options: RelayOptions): Promise<Relay> {
  const { workspace } = options
  verbose = options.verbose ?? false
  // Keep warnings visible without --verbose — actionable hints (e.g. "Codex
  // sessions exist but none match this workspace") must reach the user.
  if (!verbose) setLogLevel('warn')
  if (relayCreated) {
    throw new Error('createRelay() can only be called once per process')
  }
  relayCreated = true
  offboardLookup = options.offboarded ?? NO_OFFBOARDING
  autoOffboardMs = typeof options.autoOffboardMinutes === 'number' && options.autoOffboardMinutes > 0
    ? options.autoOffboardMinutes * 60_000 : undefined
  cloudLimits = { ...DEFAULT_CLOUD_LIMITS, ...options.cloudLimits }

  const mode = resolveRuntimeMode(options.runtime)
  const wantClaude = mode === 'claude' || mode === 'auto'
  const wantCodex = mode === 'codex' || mode === 'auto'
  log(`[relay] Runtime mode: ${mode} (watching: ${[wantClaude && 'claude', wantCodex && 'codex'].filter(Boolean).join(', ')})`)

  let hookServer: HookServer | null = null
  let scanInterval: NodeJS.Timeout | null = null

  if (wantClaude) {
    hookServer = new HookServer()
    const hookPort = await hookServer.start()
    if (hookPort === HOOK_SERVER_NOT_STARTED) {
      throw new Error('Failed to start hook server (port in use)')
    }

    hookServer.onEvent((event: AgentEvent) => {
      // Hook events are not buffered or observed; they are only dropped when they are about a hidden agent.
      if (!graphAgents.isVisible(event, offboardLookup)) return
      const data = serialize({ type: 'agent-event', event })
      if (data !== null) broadcast(data)
    })

    writeDiscoveryFile(hookPort, workspace)

    const registered = options.projects ?? (() => [])
    currentTargets = () => {
      let list: WatchedProject[] = []
      try { list = registered() } catch (e) { log('[relay] project list failed:', e) }
      return watchTargets(list, workspace)
    }
    scanForActiveSessions(currentTargets())
    scanInterval = setInterval(() => scanForActiveSessions(currentTargets()), SCAN_INTERVAL_MS)
  }

  // ─── Codex runtime ────────────────────────────────────────────────────────
  // Watch Codex rollouts in parallel. No-op if ~/.codex/sessions doesn't
  // exist or no sessions match the current workspace.
  // We don't subscribe to onSessionDetected — it fires together with the
  // lifecycle 'started' event in CodexSessionWatcher.attachSession, so
  // wiring both would double-broadcast session-started to SSE clients.
  let codexWatcher: CodexSessionWatcher | null = null
  if (wantCodex) {
    codexWatcher = new CodexSessionWatcher(workspace)
    codexWatcher.onEvent((event) => broadcastEvent(event))
    codexWatcher.onSessionLifecycle((lifecycle) => {
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label)
    })
    codexWatcher.start()
  }

  const telemetry = options.telemetry
  const sessionStart = Date.now()
  let relayDisposed = false
  const relaySessionId = `relay-${process.pid}-${Math.floor(sessionStart / 1000)}`
  sessionEventCount = 0

  const agentFlowVersion = resolveAgentFlowVersion()

  const baseEvent = () => ({
    session_id: relaySessionId,
    agent_flow_version: agentFlowVersion,
    os: os.platform(),
    arch: os.arch(),
  })

  telemetry?.emit({ ...baseEvent(), event_type: 'session_start' })

  process.on('uncaughtException', (err) => {
    try {
      telemetry?.emit({
        ...baseEvent(),
        event_type: 'error',
        error_class: err?.constructor?.name ?? 'Error',
      })
    } catch { /* don't let the handler itself crash */ }
    // Preserve default crash-on-uncaught behavior: log, then exit.
    console.error(err)
    process.exit(1)
  })

  return {
    handleSSE(req: http.IncomingMessage, res: http.ServerResponse) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      sseClients.add(res)
      log(`[sse] Client connected (${sseClients.size} total)`)

      req.on('close', () => {
        sseClients.delete(res)
        log(`[sse] Client disconnected (${sseClients.size} total)`)
      })

      // Send current session list (Claude + Codex)
      const sessionList: SessionInfo[] = []
      for (const session of sessions.values()) {
        if (!session.sessionDetected) continue
        sessionList.push({
          id: session.sessionId, ...sessionView(session.sessionId, session.label),
          status: session.sessionCompleted ? 'completed' : 'active',
          startTime: session.sessionStartTime, lastActivityTime: session.lastActivityTime,
        })
      }
      if (codexWatcher) sessionList.push(...codexWatcher.getActiveSessions())
      // Retired cloud sessions were removed from every viewer (session-removed): not listed, not replayed.
      for (const s of cloudSessions.values()) if (!s.retired) sessionList.push(cloudView(s))
      if (sessionList.length > 0) {
        sendSSE(res, { type: 'session-list', sessions: sessionList })
      }

      // Replay buffered events for every session (the client keeps them per session, so switching tabs or
      // projects shows the full team), the most recent active session last.
      const sorted = [...sessionList].sort((a, b) => {
        const aActive = a.status === 'active' ? 1 : 0
        const bActive = b.status === 'active' ? 1 : 0
        if (aActive !== bActive) return aActive - bActive
        return a.lastActivityTime - b.lastActivityTime
      })
      // Each event is serialised on its own: one that cannot be serialised is left out, the client stays. Cloud
      // sessions share a byte budget per client, given to the most recent sessions first (newest events of each).
      const texts = new Map<string, string[]>()
      let cloudBudget = cloudLimits.replayBytes
      for (const s of [...sorted].reverse()) {
        const buffered = eventBuffer.get(s.id)
        if (!buffered) continue
        // Offboarded agents that are not running are left out, so a reload or restart does not bring them back.
        const visible = graphAgents.visibleEvents(buffered, offboardLookup)
        const out: string[] = []
        const isCloud = cloudSessions.has(s.id)
        for (let i = visible.length - 1; i >= 0; i--) {
          const text = serialize(visible[i])
          if (text === null) continue
          if (isCloud) {
            const bytes = Buffer.byteLength(text) + 1
            if (bytes > cloudBudget) break
            cloudBudget -= bytes
          }
          out.push(text)
        }
        texts.set(s.id, out.reverse())
      }
      for (const s of sorted) {
        const out = texts.get(s.id)
        if (out) writeSSE(res, `{"type":"agent-event-batch","events":[${out.join(',')}]}`)
      }
    },

    graph: {
      agents: (sessionId) => (sessions.has(sessionId) || cloudSessions.has(sessionId) ? graphAgents.agents(sessionId) : null),
      sessionProject: (sessionId) => sessionProjects.get(sessionId)?.id || cloudSessions.get(sessionId)?.projectId || null,
      announceOffboarded,
      finishOrphaned: (sessionId, agent) => finishCloudAgentIfRunning(sessionId, agent, true),
      sessions: () => [...sessions.keys(), ...cloudSessions.keys()],
      onAgentsChanged: (listener) => {
        agentsChangedListeners.add(listener)
        return () => { agentsChangedListeners.delete(listener) }
      },
    },

    cloud: {
      apply: applyCloudMessages,
      setStale: setCloudSourceStale,
      sourceOf: (sessionId) => cloudSessions.get(sessionId)?.sourceId ?? null,
      makeRoom: makeCloudRoom,
      forgetSource: forgetCloudSource,
      retireSource: retireCloudSource,
      finishSource: finishCloudSource,
      finishAgent: (sessionId, agent) => finishCloudAgentIfRunning(sessionId, agent, false),
      moveSource: moveCloudSource,
      announceProjectsChanged: () => broadcast(JSON.stringify({ type: 'projects-changed' })),
    },

    dispose() {
      // Defense in depth — server.ts already guards cleanup(), but direct
      // callers or hot-reload could call this twice.
      if (relayDisposed) return
      relayDisposed = true
      agentsChangedListeners.clear()
      const models = [...observedModels].sort().join(',').slice(0, 128)
      const runtimes = [wantClaude && 'claude', wantCodex && 'codex'].filter(Boolean).join(',')
      telemetry?.emit({
        ...baseEvent(),
        event_type: 'session_end',
        duration_s: Math.round((Date.now() - sessionStart) / 1000),
        event_count: sessionEventCount,
        models: models || undefined,
        runtimes: runtimes || undefined,
      })
      if (wantClaude) {
        removeDiscoveryFile()
        hookServer?.dispose()
        if (scanInterval) clearInterval(scanInterval)
        for (const w of projectDirWatchers.values()) w.close()
        projectDirWatchers.clear()
        for (const session of sessions.values()) {
          session.fileWatcher?.close()
          session.subagentsDirWatcher?.close()
          for (const st of session.subagentWatchers.values()) {
            st.watcher?.close()
            if (st.permissionTimer) clearTimeout(st.permissionTimer)
          }
          if (session.pollTimer) clearInterval(session.pollTimer)
          if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
        }
      }
      codexWatcher?.dispose()
    },
  }
}
