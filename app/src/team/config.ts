/**
 * Team monitor home folder and project registry.
 *
 * Home: $TEAM_MONITOR_HOME or ~/.team-monitor (created 0700). It holds
 * config.json ({"projects":[{"id","name","path"}]}), and in remote mode the
 * access token and the session store.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface ProjectEntry {
  id: string
  name: string
  /** Absolute, resolved path of the project folder. */
  path: string
}

export function teamHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TEAM_MONITOR_HOME
  if (override && override.trim()) return path.resolve(expandHome(override.trim()))
  return path.join(os.homedir(), '.team-monitor')
}

/** Create the home folder with 0700, and tighten it if it already exists wider. */
export function ensureHome(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const st = fs.statSync(home)
  if (!st.isDirectory()) throw new Error(`${home} is not a directory`)
  if ((st.mode & 0o077) !== 0) fs.chmodSync(home, 0o700)
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug || 'project'
}

interface RawEntry { id?: unknown; name?: unknown; path?: unknown }

/** config.json parsed, or null when it is missing or unreadable (reported, not fatal). */
function readConfigJson(home: string, warn: (msg: string) => void): { file: string; data: Record<string, unknown> | null } {
  const file = path.join(home, 'config.json')
  let text: string
  try {
    const st = fs.statSync(file)
    if (st.size > 1024 * 1024) { warn(`[team] ${file} is larger than 1 MB, ignored`); return { file, data: null } }
    text = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warn(`[team] cannot read ${file}: ${(e as Error).message}`)
    return { file, data: null }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(`[team] ${file} must hold a JSON object`)
      return { file, data: null }
    }
    return { file, data: parsed as Record<string, unknown> }
  } catch (e) {
    warn(`[team] ${file} is not valid JSON: ${(e as Error).message}`)
    return { file, data: null }
  }
}

/** Read config.json. A missing file means no projects; a broken one is reported, not fatal. */
export function readConfigProjects(home: string, warn: (msg: string) => void = console.warn): RawEntry[] {
  const { file, data } = readConfigJson(home, warn)
  // A config with only other settings (e.g. autoOffboardMinutes) has no projects; that is not an error.
  if (!data || data.projects === undefined) return []
  if (!Array.isArray(data.projects)) { warn(`[team] ${file}: "projects" must be an array`); return [] }
  return data.projects.filter((p): p is RawEntry => !!p && typeof p === 'object')
}

/** Default and bounds of `autoOffboardMinutes` in config.json (spec ui-cleanup item 6). */
export const AUTO_OFFBOARD_DEFAULT_MINUTES = 60
export const AUTO_OFFBOARD_MIN_MINUTES = 1
export const AUTO_OFFBOARD_MAX_MINUTES = 7 * 24 * 60

/**
 * Minutes after a sub-agent finished before the server offboards it (`autoOffboardMinutes` in config.json).
 * Missing: 60. Anything but a whole number from 1 to 10080 (one week) is reported and the default is used.
 * Read at start; a change applies after a restart.
 */
export function readAutoOffboardMinutes(home: string, warn: (msg: string) => void = console.warn): number {
  // A broken file is already reported by readConfigProjects at start; say nothing twice.
  const { file, data } = readConfigJson(home, () => {})
  const v = data?.autoOffboardMinutes
  if (v === undefined) return AUTO_OFFBOARD_DEFAULT_MINUTES
  if (typeof v !== 'number' || !Number.isInteger(v) || v < AUTO_OFFBOARD_MIN_MINUTES || v > AUTO_OFFBOARD_MAX_MINUTES) {
    warn(`[team] ${file}: "autoOffboardMinutes" must be a whole number from ${AUTO_OFFBOARD_MIN_MINUTES} to ${AUTO_OFFBOARD_MAX_MINUTES}; using ${AUTO_OFFBOARD_DEFAULT_MINUTES}`)
    return AUTO_OFFBOARD_DEFAULT_MINUTES
  }
  return v
}

/**
 * Build the registry from config entries plus `--project <path>` arguments.
 * Only existing folders are kept; the same folder is listed once; ids are unique.
 */
export function buildRegistry(configEntries: RawEntry[], cliPaths: string[], cwd = process.cwd()): ProjectEntry[] {
  const out: ProjectEntry[] = []
  const seenPaths = new Set<string>()
  const seenIds = new Set<string>()

  const add = (rawPath: string, rawId?: unknown, rawName?: unknown) => {
    const abs = path.resolve(cwd, expandHome(rawPath))
    let real: string
    try {
      real = fs.realpathSync(abs)
      if (!fs.statSync(real).isDirectory()) return
    } catch {
      return
    }
    if (seenPaths.has(real)) return
    seenPaths.add(real)

    const folder = path.basename(real)
    const base = typeof rawId === 'string' && ID_RE.test(rawId) ? rawId : slugify(folder)
    let id = base
    for (let n = 2; seenIds.has(id); n++) id = `${base}-${n}`
    seenIds.add(id)
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 120) : folder
    out.push({ id, name, path: real })
  }

  for (const e of configEntries) {
    if (typeof e.path === 'string' && e.path.trim()) add(e.path.trim(), e.id, e.name)
  }
  for (const p of cliPaths) add(p)
  return out
}

export function agentTeamDir(projectPath: string): string {
  return path.join(projectPath, '.agent-team')
}

export function hasState(projectPath: string): boolean {
  try { return fs.statSync(path.join(agentTeamDir(projectPath), 'state.json')).isFile() } catch { return false }
}
