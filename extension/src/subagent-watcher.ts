/**
 * Subagent file watching logic extracted from SessionWatcher.
 *
 * Manages per-session subagent JSONL file discovery, tailing, and event emission.
 *
 * When inline progress events are active for a subagent (tracked via
 * session.inlineProgressAgents), the file watcher still tracks file position
 * but skips event emission to avoid duplicates. This allows seamless fallback
 * to file-based watching on reconnection when inline progress is no longer flowing.
 */

import * as fs from 'fs'
import * as path from 'path'
import { AgentEvent, SubagentState, WatchedSession, emitSubagentSpawn } from './protocol'
import { SESSION_ID_DISPLAY, ORCHESTRATOR_NAME, SUBAGENT_ID_SUFFIX_LENGTH, generateSubagentFallbackName, resolveSubagentChildName } from './constants'
import { readNewFileLines } from './fs-utils'
import { TranscriptParser } from './transcript-parser'
import { handlePermissionDetection, PermissionDetectionDelegate } from './permission-detection'
import { createLogger } from './logger'

const log = createLogger('SubagentWatcher')

export interface SubagentWatcherDelegate extends PermissionDetectionDelegate {
  getSession(sessionId: string): WatchedSession | undefined
  resetInactivityTimer(sessionId: string): void
}

/**
 * Read the .meta.json sidecar file to resolve the subagent's name.
 * Falls back to generateSubagentFallbackName if the meta file is missing or unreadable.
 *
 * For agents that carry no descriptive name in their meta (e.g. Workflow
 * subagents, whose meta is just `{"agentType":"workflow-subagent"}`), we derive
 * a stable name from the transcript file's own id (agent-<hash>.jsonl) so each
 * one renders as a distinct node instead of colliding on a generic label.
 */
function resolveNameFromMeta(jsonlPath: string, fallbackIndex: number, unclaimed?: () => string[]): string {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  // Stable id from the filename, e.g. "agent-a0fb14872db487d5b" → "a0fb14872db487d5b"
  const fileId = path.basename(jsonlPath, '.jsonl')
  const agentId = fileId.replace(/^agent-/, '')
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8')
    const meta = JSON.parse(raw) as Record<string, unknown>
    const name = resolveSubagentChildName(meta)
    if (name && name !== 'subagent') return name
    // No descriptive name (e.g. Workflow subagents: {"agentType":"workflow-subagent"}).
    // Use the same `<agentType>-<id suffix>` convention as the SubagentStop hook
    // (hook-server.ts) so hook-emitted completion events resolve to this node.
    if (typeof meta.agentType === 'string' && meta.agentType) {
      return `${meta.agentType}-${agentId.slice(-SUBAGENT_ID_SUFFIX_LENGTH)}`
    }
  } catch { /* meta file may not exist for older Claude Code versions, or not yet */ }
  // The transcript can appear a moment before its .meta.json (seen in a cloud session, 15 Nov 2026). The main
  // transcript has already named the sub-agent from its Agent call; when exactly one such sub-agent has no
  // transcript of its own yet, this file is it. Otherwise the same agent showed up twice ("subagent-174432").
  const candidates = unclaimed?.() ?? []
  if (candidates.length === 1) return candidates[0]
  return generateSubagentFallbackName(agentId, fallbackIndex)
}

/** Sub-agents the main transcript dispatched (by name) that no watched transcript file belongs to yet. */
export function unclaimedSubagentNames(spawned: Iterable<string>, watchedNames: Iterable<string>): string[] {
  const claimed = new Set(watchedNames)
  return [...new Set(spawned)].filter((n) => !claimed.has(n))
}

/** Recursively collect every agent-*.jsonl transcript under a subagents directory.
 *  Newer Claude Code nests Workflow subagents under
 *  `subagents/workflows/wf_<id>/agent-*.jsonl`, so a flat readdir misses them.
 *  Other .jsonl files in the tree (e.g. the workflow `journal.jsonl`) are not
 *  agent transcripts and would otherwise render as bogus subagent nodes. */
export function collectSubagentJsonlFiles(dir: string): string[] {
  const found: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch { return found }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...collectSubagentJsonlFiles(full))
    } else if (entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
      found.push(full)
    }
  }
  return found
}

/** Newest mtime (ms) across every *.jsonl under a subagents directory, recursively.
 *  Used for session-liveness checks: a session whose main transcript is stale may
 *  still be running Workflow subagents that only write under
 *  `subagents/workflows/wf_<id>/`. Deliberately includes non-agent files like the
 *  workflow `journal.jsonl` — during a run it is often the most recently written
 *  file, and any write under the tree means the session is alive.
 *  Returns 0 if the directory is missing or has no .jsonl files. */
export function newestSubagentMtime(dir: string): number {
  let newest = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch { return newest }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = newestSubagentMtime(full)
      if (sub > newest) newest = sub
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const mt = fs.statSync(full).mtimeMs
        if (mt > newest) newest = mt
      } catch { /* file may vanish mid-scan */ }
    }
  }
  return newest
}

function birthMs(filePath: string): number {
  try {
    const st = fs.statSync(filePath)
    return st.birthtimeMs || st.mtimeMs
  } catch { return 0 }
}

/** What a subagent's `.meta.json` sidecar says about how it was launched and whether it finished. */
export interface SubagentMeta {
  toolUseId?: string
  finished?: boolean
  model?: string
}

export function readSubagentMeta(jsonlPath: string): SubagentMeta {
  try {
    const meta = JSON.parse(fs.readFileSync(jsonlPath.replace(/\.jsonl$/, '.meta.json'), 'utf-8')) as Record<string, unknown>
    const model = meta.pickedEffortModel
    return {
      toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : undefined,
      finished: meta.finished === true,
      model: typeof model === 'string' && model.startsWith('claude-') ? model : undefined,
    }
  } catch { return {} }
}

/**
 * Whether a subagent found when a session is (re)attached has already finished.
 * Claude Code writes `finished: true` into the meta sidecar when a subagent stops.
 * Without it (older versions, or still running), the subagent counts as running
 * while its own transcript has unmatched tool calls, its Agent/Task launch has no
 * tool_result yet, or its background launch has no <task-notification> yet.
 */
export function isSubagentFinishedAtAttach(s: {
  metaFinished: boolean
  pendingInFile: number
  launchPending: boolean
  backgroundRunning: boolean
}): boolean {
  if (s.metaFinished) return true
  return !(s.pendingInFile > 0 || s.launchPending || s.backgroundRunning)
}

/**
 * Rebuild every subagent of a session that is being attached (page load after a
 * server restart, or a session first seen with history). Each transcript under
 * `subagents/` gets a node: finished ones are spawned and completed at once (the
 * graph keeps them dimmed), running ones stay live and are tailed from here on.
 */
export function rebuildSubagentsOnAttach(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  sessionId: string,
): void {
  scanSubagentsDir(delegate, parser, sessionId, new Set())
}

/** Scan the subagents directory for new JSONL files and start tailing them */
export function scanSubagentsDir(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  sessionId: string,
  rebuilt?: Set<string>,
): void {
  const session = delegate.getSession(sessionId)
  if (!session || !session.subagentsDir) return

  // Start watching the directory tree once it exists. Try a recursive watch
  // first (supported on Windows/macOS) so nested workflow subagent files are
  // detected promptly; fall back to a flat watch on platforms without recursive
  // support (Linux). Either way the POLL_FALLBACK_MS poll re-scans recursively.
  if (!session.subagentsDirWatcher && fs.existsSync(session.subagentsDir)) {
    const onChange = () => scanSubagentsDir(delegate, parser, sessionId)
    try {
      session.subagentsDirWatcher = fs.watch(session.subagentsDir, { recursive: true }, onChange)
    } catch {
      try {
        session.subagentsDirWatcher = fs.watch(session.subagentsDir, onChange)
      } catch (err) { log.debug('Subagent dir watch failed:', err) }
    }
  }

  const subDir = session.subagentsDir
  if (!fs.existsSync(subDir)) return

  try {
    // Recurse — Workflow subagents live under subagents/workflows/wf_<id>/.
    const files = collectSubagentJsonlFiles(subDir)
    // A rebuild spawns the nodes oldest first, the order the team was launched in.
    if (rebuilt) files.sort((a, b) => birthMs(a) - birthMs(b))
    for (const filePath of files) {
      if (session.subagentWatchers.has(filePath)) continue
      startWatchingSubagentFile(delegate, parser, filePath, sessionId, rebuilt)
    }
  } catch (err) { log.debug('Subagent dir scan failed:', err) }
}

/**
 * Watch agent transcripts in subagent folders other than `session.subagentsDir`.
 * Older Claude Code versions kept a session's transcript in place after it
 * entered a worktree but wrote its subagents under the worktree's project folder.
 */
export function scanExtraSubagentDirs(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  sessionId: string,
  dirs: readonly string[],
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return
  for (const dir of dirs) {
    for (const filePath of collectSubagentJsonlFiles(dir)) {
      if (session.subagentWatchers.has(filePath)) continue
      startWatchingSubagentFile(delegate, parser, filePath, sessionId)
    }
  }
}

/**
 * Re-key subagent watchers after their folder moved from `fromDir` to `toDir`,
 * keeping each one's read offset so nothing is skipped or replayed.
 */
export function moveSubagentWatchers(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  sessionId: string,
  fromDir: string,
  toDir: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return
  for (const [oldPath, state] of [...session.subagentWatchers]) {
    const rel = path.relative(fromDir, oldPath)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    const newPath = path.join(toDir, rel)
    state.watcher?.close()
    state.watcher = null
    session.subagentWatchers.delete(oldPath)
    // Already picked up at its new path by a scan that ran mid-move
    if (session.subagentWatchers.has(newPath)) continue
    session.subagentWatchers.set(newPath, state)
    try {
      state.watcher = fs.watch(newPath, () => {
        readSubagentNewLines(delegate, parser, newPath, sessionId)
      })
    } catch (err) { log.debug('Subagent file watch failed:', err) }
  }
}

function startWatchingSubagentFile(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  sessionId: string,
  rebuilt?: Set<string>,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return

  // Resolve name from the meta file (deterministic, no queue race)
  const agentName = resolveNameFromMeta(filePath, session.subagentWatchers.size + 1, () =>
    unclaimedSubagentNames(session.spawnedSubagents, [...session.subagentWatchers.values()].map((w) => w.agentName)))
  log.info(`Tailing subagent: ${path.basename(filePath)} as "${agentName}" (session ${sessionId.slice(0, SESSION_ID_DISPLAY)})`)

  const state: SubagentState = {
    watcher: null,
    fileSize: 0,
    fileTail: '',
    agentName,
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    permissionTimer: null,
    permissionEmitted: false,
    spawnEmitted: false,
    completed: false,
  }
  session.subagentWatchers.set(filePath, state)

  // Pre-scan existing content for dedup IDs and determine if the subagent
  // is still active (has unmatched tool_use blocks = pending work).
  const pendingToolUseIds = new Set<string>()
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > 0) {
      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const raw: unknown = JSON.parse(line.trim())
          const entry = raw as { message?: { content?: Array<{ type: string; id?: string; tool_use_id?: string }> } }
          if (raw && typeof raw === 'object' && entry.message && Array.isArray(entry.message.content)) {
            for (const block of entry.message.content) {
              if (block.type === 'tool_use' && block.id) {
                state.seenToolUseIds.add(block.id)
                pendingToolUseIds.add(block.id)
              } else if (block.type === 'tool_result' && block.tool_use_id) {
                pendingToolUseIds.delete(block.tool_use_id)
              }
            }
          }
        } catch { /* skip unparseable subagent transcript lines */ }
      }
      state.fileSize = stat.size
    }
  } catch (err) { log.debug('Subagent initial read failed:', err) }

  if (rebuilt) {
    // Session attach: the pre-scan of the main transcript only recorded names in
    // spawnedSubagents, nothing was emitted yet, so every subagent gets its node here.
    state.spawnEmitted = true
    session.spawnedSubagents.add(agentName)
    if (!rebuilt.has(agentName)) {
      rebuilt.add(agentName)
      const meta = readSubagentMeta(filePath)
      emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, agentName, agentName, sessionId)
      if (meta.model && !session.modelDetectedAgents.has(agentName)) {
        session.modelDetectedAgents.set(agentName, meta.model)
        delegate.emit({ time: delegate.elapsed(sessionId), type: 'model_detected', payload: { agent: agentName, model: meta.model } }, sessionId)
      }
      const finished = isSubagentFinishedAtAttach({
        metaFinished: meta.finished === true,
        pendingInFile: pendingToolUseIds.size,
        launchPending: meta.toolUseId ? session.pendingToolCalls.has(meta.toolUseId) : false,
        backgroundRunning: meta.toolUseId ? parser.isBackgroundSubagentRunning(meta.toolUseId) : false,
      })
      if (finished) {
        state.completed = true
        delegate.emit({ time: delegate.elapsed(sessionId), type: 'agent_complete', payload: { name: agentName } }, sessionId)
      }
    }
  } else {
    // Only emit spawn for subagents that are still active (have pending work)
    // AND haven't already been spawned by the transcript parser.
    emitSpawnIfActive(delegate, session, state, agentName, pendingToolUseIds.size > 0, sessionId)
  }

  // Watch for new content
  try {
    state.watcher = fs.watch(filePath, () => {
      readSubagentNewLines(delegate, parser, filePath, sessionId)
    })
  } catch (err) { log.debug('Subagent file watch failed:', err) }
}

function emitSpawnIfActive(
  delegate: SubagentWatcherDelegate,
  session: WatchedSession,
  state: SubagentState,
  agentName: string,
  hasPendingWork: boolean,
  sessionId: string,
): void {
  const alreadySpawned = session.spawnedSubagents.has(agentName)
  state.spawnEmitted = hasPendingWork || alreadySpawned
  if (hasPendingWork && !alreadySpawned) {
    session.spawnedSubagents.add(agentName)
    emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, agentName, agentName, sessionId)
  }
}

export function readSubagentNewLines(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return
  const state = session.subagentWatchers.get(filePath)
  if (!state) return

  const result = readNewFileLines(filePath, state.fileSize, state.fileTail)
  if (!result) return
  state.fileSize = result.newSize
  state.fileTail = result.tail

  // If inline progress events are handling this subagent, skip event emission
  // from the file watcher to avoid duplicates. We still advance fileSize above
  // so that if inline progress stops (e.g. reconnection), we resume from the
  // correct position without re-emitting old events.
  if (session.inlineProgressAgents.has(state.agentName)) {
    // Still keep the session alive — the subagent is working
    delegate.resetInactivityTimer(sessionId)
    return
  }

  // Lazily emit spawn on first new content if not already emitted
  if (!state.spawnEmitted) {
    state.spawnEmitted = true
    if (!session.spawnedSubagents.has(state.agentName)) {
      session.spawnedSubagents.add(state.agentName)
      emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, state.agentName, state.agentName, sessionId)
    }
  }

  // Node was completed (e.g. by its Workflow tool_result) but the transcript is
  // being written again — a resumed run. Revive it, mirroring how the
  // orchestrator node is resurrected in resetInactivityTimer.
  if (state.completed) {
    state.completed = false
    emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, state.agentName, state.agentName, sessionId)
  }

  for (const line of result.lines) {
    parser.processTranscriptLine(line, state.agentName, state.pendingToolCalls, state.seenToolUseIds, sessionId)
  }

  // Permission detection for subagent tools
  handlePermissionDetection(delegate, state.agentName, state.pendingToolCalls, state, sessionId)

  // Keep main session alive while subagents are working
  delegate.resetInactivityTimer(sessionId)
}
