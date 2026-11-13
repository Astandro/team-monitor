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

export interface WatchedProject {
  /** Registry id, or '' for the start-folder fallback. */
  id: string
  /** Registry name (folder name when not configured). */
  name: string
  /** Absolute project folder. */
  path: string
  /** `meta.title` from the project's `.agent-team/state.json`, when it has one. */
  title?: string
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

/** `meta.title` of a parsed state.json, when it is a non-empty string. */
export function titleFromState(state: unknown): string | undefined {
  if (!state || typeof state !== 'object') return undefined
  const meta = (state as { meta?: unknown }).meta
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
