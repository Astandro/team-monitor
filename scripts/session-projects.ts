/**
 * Which Claude Code sessions the graph shows, and what they are called (spec graph-theme items 3-4).
 *
 * Claude Code keeps a session under `~/.claude/projects/<encoded folder>/`, where the folder path has every
 * character other than a-z, A-Z, 0-9 replaced by '-'. A session belongs to a project when its folder is the
 * project folder itself or a worktree inside it (`<project>/.claude/worktrees/x` encodes as `<encoded>--claude-...`).
 * Sibling folders that only share a prefix (`my-app` vs `my-app-team`) do not match.
 */
import * as fs from 'fs'
import * as path from 'path'
import { foldPathCase } from '../extension/src/fs-utils'
import type { CoordinatorInfo } from '../extension/src/protocol'

export interface WatchedProject {
  /** Registry id, or '' for the start-folder fallback. */
  id: string
  /** Registry name (folder name when not configured). */
  name: string
  /** Absolute project folder. */
  path: string
  /** `meta.title` from the project's `.agent-team/state.json`, when it has one. */
  title?: string
  /** `meta.coordinator` from the same file, when it names one (spec offboard-names item 2). */
  coordinator?: CoordinatorInfo
}

export const COORDINATOR_DEFAULT_ROLE = 'Orchestrator'
export const COORDINATOR_FIELD_MAX = 60

/**
 * `meta.coordinator` of a parsed state.json: `{"name": "Sora", "role": "Orchestrator"}`. The name must be a
 * non-empty string (at most 60 characters after trimming); a missing, empty or non-string role becomes
 * "Orchestrator". Anything else gives undefined, so the graph keeps the plain "Orchestrator" label.
 */
export function coordinatorFromState(state: unknown): CoordinatorInfo | undefined {
  if (!state || typeof state !== 'object') return undefined
  const meta = (normalizeTeamState(state) as { meta?: unknown }).meta
  if (!meta || typeof meta !== 'object') return undefined
  const c = (meta as { coordinator?: unknown }).coordinator
  if (!c || typeof c !== 'object' || Array.isArray(c)) return undefined
  const rawName = (c as { name?: unknown }).name
  const rawRole = (c as { role?: unknown }).role
  const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim() : ''
  if (!name || name.length > COORDINATOR_FIELD_MAX) return undefined
  const role = typeof rawRole === 'string' ? rawRole.replace(/\s+/g, ' ').trim().slice(0, COORDINATOR_FIELD_MAX) : ''
  return { name, role: role || COORDINATOR_DEFAULT_ROLE }
}

/**
 * Payload of the main agent's `agent_spawn`. With a coordinator it also carries `coordinator` and, like a named
 * sub-agent, `displayName` and `role`; the node name stays "orchestrator".
 */
export function mainSpawnPayload(name: string, task: string, model: string | null, coordinator: CoordinatorInfo | undefined): Record<string, unknown> {
  return {
    name, isMain: true, task,
    ...(model ? { model } : {}),
    ...(coordinator ? { coordinator: { ...coordinator }, displayName: coordinator.name, role: coordinator.role } : {}),
  }
}

export function sameCoordinator(a: CoordinatorInfo | undefined, b: CoordinatorInfo | undefined): boolean {
  return a?.name === b?.name && a?.role === b?.role
}

export function encodeProjectPath(p: string): string {
  let resolved = p
  try { resolved = fs.realpathSync(p) } catch { /* keep as given */ }
  return resolved.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The project a `~/.claude/projects/<dirName>` folder belongs to; the most specific (longest) match wins. */
export function matchProjectDir<T extends Pick<WatchedProject, 'path'>>(dirName: string, projects: readonly T[]): T | null {
  const dir = foldPathCase(dirName)
  let best: T | null = null
  let bestLen = -1
  for (const p of projects) {
    const enc = foldPathCase(encodeProjectPath(p.path))
    if ((dir === enc || dir.startsWith(enc + '--')) && enc.length > bestLen) {
      best = p
      bestLen = enc.length
    }
  }
  return best
}

/**
 * A parsed state.json in the shape the monitor reads, from the shapes coordinators really write (seen 15 Nov 2026):
 * - fields under `meta.run` (the artifact monitor's `meta/run` document) also count as `meta.<field>`; a field set
 *   directly on `meta` wins;
 * - `meta.coordinator` (or `meta.run.coordinator`) as a plain string is the coordinator's name;
 * - without any coordinator, the agent with `desk: "coordinator"` is it (its `nick`, its `name` as the role).
 * Everything else is kept as it is. Returns a new object; the input is not changed.
 */
export function normalizeTeamState<T>(state: T): T {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const s = state as Record<string, unknown>
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const meta = isObj(s.meta) ? s.meta : undefined
  const run = meta && isObj(meta.run) ? meta.run : undefined
  const merged: Record<string, unknown> = { ...(run ?? {}), ...(meta ?? {}) }
  for (const [k, v] of Object.entries(run ?? {})) if (merged[k] === undefined) merged[k] = v
  let c: unknown = merged.coordinator
  if (c === undefined && run) c = run.coordinator
  if (typeof c === 'string') c = c.trim() ? { name: c.trim() } : undefined
  if (!isObj(c) && isObj(s.agents)) {
    for (const a of Object.values(s.agents)) {
      if (isObj(a) && a.desk === 'coordinator' && typeof a.nick === 'string' && a.nick.trim()) {
        c = { name: a.nick.trim(), ...(typeof a.name === 'string' && a.name.trim() ? { role: a.name.trim() } : {}) }
        break
      }
    }
  }
  if (isObj(c)) merged.coordinator = c
  else delete merged.coordinator
  if (!meta && !isObj(c)) return state
  return { ...s, meta: merged } as T
}

/** `meta.title` of a parsed state.json, when it is a non-empty string. */
export function titleFromState(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined
  const meta = (normalizeTeamState(state) as { meta?: unknown }).meta
  if (!meta || typeof meta !== 'object') return undefined
  const title = (meta as { title?: unknown }).title
  return typeof title === 'string' && title.trim() ? title.trim() : undefined
}

/** Session label: the project's title, else its name, else the folder name. Never the first prompt. */
export function projectSessionLabel(project: Pick<WatchedProject, 'name' | 'path' | 'title'>): string {
  const title = project.title?.trim()
  if (title) return title
  const name = project.name?.trim()
  if (name) return name
  return path.basename(project.path) || project.path
}

/** Registered projects when there are any; otherwise the folder the server was started from (upstream behaviour). */
export function watchTargets(registered: readonly WatchedProject[], startFolder: string): WatchedProject[] {
  if (registered.length > 0) return [...registered]
  return [{ id: '', name: path.basename(startFolder), path: startFolder }]
}
