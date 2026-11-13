/**
 * `team-monitor project add|remove|list`: manage the projects in config.json.
 *
 * config.json is edited atomically (temp file 0600 in the home folder, fsync, rename, folder fsync) and every other
 * key in it (askHook, autoOffboardMinutes, ...) is kept. The home folder is 0700. `add` also creates
 * `<path>/.agent-team/` and lists `.agent-team/` in the repo's `.git/info/exclude` (never the tracked .gitignore).
 *
 * The running server reads config.json only at start, so add/remove restart the installed service (service.ts)
 * unless --no-restart is given.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { ensureHome, expandHome, slugify, teamHome } from './config'

const MAX_CONFIG_BYTES = 1024 * 1024
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export class ProjectError extends Error {}

export interface StoredProject { id: string; name: string; path: string }

export function configFile(home: string): string {
  return path.join(home, 'config.json')
}

/** config.json as an object ({} when missing). Throws ProjectError when it is broken, so it is never overwritten. */
export function loadConfig(home: string): Record<string, unknown> {
  const file = configFile(home)
  let text: string
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile()) throw new ProjectError(`${file} is not a regular file; fix it by hand first.`)
    if (st.size > MAX_CONFIG_BYTES) throw new ProjectError(`${file} is larger than 1 MB; fix it by hand first.`)
    text = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    if (e instanceof ProjectError) throw e
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ProjectError(`cannot read ${file}: ${(e as Error).message}`)
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    throw new ProjectError(`${file} is not valid JSON; fix it by hand first (nothing was changed).`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectError(`${file} must hold a JSON object; fix it by hand first (nothing was changed).`)
  }
  const data = parsed as Record<string, unknown>
  if (data.projects !== undefined && !Array.isArray(data.projects)) {
    throw new ProjectError(`${file}: "projects" must be an array; fix it by hand first (nothing was changed).`)
  }
  return data
}

/** Write config.json atomically with mode 0600 in a 0700 home folder. */
export function saveConfig(home: string, data: Record<string, unknown>): void {
  ensureHome(home)
  const file = configFile(home)
  const tmp = path.join(home, `.config.json.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.chmodSync(tmp, 0o600) // the umask cannot widen it, but be explicit
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* already gone */ }
    throw e
  }
  try {
    const dfd = fs.openSync(home, 'r')
    try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
  } catch { /* directory fsync is best effort */ }
}

export function storedProjects(data: Record<string, unknown>): StoredProject[] {
  const list = Array.isArray(data.projects) ? data.projects : []
  return list
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      id: typeof p.id === 'string' ? p.id : '',
      name: typeof p.name === 'string' ? p.name : '',
      path: typeof p.path === 'string' ? p.path : '',
    }))
}

function realOrNull(p: string): string | null {
  try { return fs.realpathSync(path.resolve(expandHome(p))) } catch { return null }
}

/**
 * The file that holds the repo's local excludes for `dir`, or null when `dir` is not inside a git repo.
 * Handles a `.git` folder and a `.git` file (worktree or submodule: `gitdir:` plus an optional `commondir`).
 */
export function gitExcludeFile(dir: string): string | null {
  let cur = dir
  for (;;) {
    const dotGit = path.join(cur, '.git')
    let st: fs.Stats | null = null
    try { st = fs.statSync(dotGit) } catch { st = null }
    if (st?.isDirectory()) return path.join(dotGit, 'info', 'exclude')
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'))
      if (!m) return null
      const gitDir = path.resolve(cur, m[1].trim())
      let common = gitDir
      try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim()) } catch { /* no commondir */ }
      return path.join(common, 'info', 'exclude')
    }
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
}

const EXCLUDE_LINES = new Set(['.agent-team', '.agent-team/', '/.agent-team', '/.agent-team/', '.agent-team/*', '.agent-team/**'])

/** Add `.agent-team/` to the repo's info/exclude. Returns what happened, for the CLI output. */
export function ensureExcluded(projectPath: string): { file: string | null; added: boolean } {
  const file = gitExcludeFile(projectPath)
  if (!file) return { file: null, added: false }
  let text = ''
  try { text = fs.readFileSync(file, 'utf-8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (text.split(/\r?\n/).some((l) => EXCLUDE_LINES.has(l.trim()))) return { file, added: false }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const sep = text === '' || text.endsWith('\n') ? '' : '\n'
  fs.appendFileSync(file, `${sep}# team monitor state (local only)\n.agent-team/\n`)
  return { file, added: true }
}

export interface AddResult {
  project: StoredProject
  /** false when the folder was already registered (the name may have been updated). */
  added: boolean
  agentTeamCreated: boolean
  exclude: { file: string | null; added: boolean }
}

export function addProject(home: string, rawPath: string, name?: string, cwd = process.cwd()): AddResult {
  const abs = path.resolve(cwd, expandHome(rawPath.trim()))
  let real: string
  try { real = fs.realpathSync(abs) } catch { throw new ProjectError(`${abs} does not exist.`) }
  if (!fs.statSync(real).isDirectory()) throw new ProjectError(`${real} is not a folder.`)
  const cleanName = name?.trim().slice(0, 120)
  if (name !== undefined && !cleanName) throw new ProjectError('--name must not be empty.')

  const data = loadConfig(home) // before touching the project: a broken config stops everything
  const list = storedProjects(data)
  const raw = (Array.isArray(data.projects) ? data.projects : []) as unknown[]

  const agentDir = path.join(real, '.agent-team')
  let agentTeamCreated = false
  try {
    const st = fs.lstatSync(agentDir)
    if (!st.isDirectory()) throw new ProjectError(`${agentDir} exists but is not a folder.`)
  } catch (e) {
    if (e instanceof ProjectError) throw e
    fs.mkdirSync(agentDir, { mode: 0o700 })
    agentTeamCreated = true
  }
  const exclude = ensureExcluded(real)

  const at = list.findIndex((p) => p.path && realOrNull(p.path) === real)
  if (at >= 0) {
    const entry = raw[at] as Record<string, unknown>
    if (cleanName && entry.name !== cleanName) {
      entry.name = cleanName
      saveConfig(home, data)
    }
    const cur = storedProjects(data)[at]
    return { project: cur, added: false, agentTeamCreated, exclude }
  }

  const taken = new Set(list.map((p) => p.id).filter((id) => ID_RE.test(id)))
  const base = slugify(path.basename(real))
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  const project = { id, name: cleanName || path.basename(real), path: real }
  data.projects = [...raw, project]
  saveConfig(home, data)
  return { project, added: true, agentTeamCreated, exclude }
}

/** Remove by id (or by path). The project's `.agent-team/` folder is left alone. */
export function removeProject(home: string, idOrPath: string, cwd = process.cwd()): StoredProject {
  const data = loadConfig(home)
  const list = storedProjects(data)
  let at = list.findIndex((p) => p.id === idOrPath)
  if (at < 0) {
    const real = realOrNull(path.resolve(cwd, expandHome(idOrPath)))
    const abs = path.resolve(cwd, expandHome(idOrPath))
    at = list.findIndex((p) => p.path && (path.resolve(expandHome(p.path)) === abs || (real && realOrNull(p.path) === real)))
  }
  if (at < 0) throw new ProjectError(`no project "${idOrPath}" in ${configFile(home)} (see: project list).`)
  const raw = (data.projects as unknown[]).slice()
  raw.splice(at, 1)
  data.projects = raw
  saveConfig(home, data)
  return list[at]
}

export interface ListedProject extends StoredProject { exists: boolean; hasAgentTeam: boolean }

export function listProjects(home: string): ListedProject[] {
  return storedProjects(loadConfig(home)).map((p) => {
    const real = p.path ? realOrNull(p.path) : null
    let exists = false
    let hasAgentTeam = false
    try { exists = !!real && fs.statSync(real).isDirectory() } catch { exists = false }
    try { hasAgentTeam = !!real && fs.statSync(path.join(real, '.agent-team')).isDirectory() } catch { hasAgentTeam = false }
    return { ...p, exists, hasAgentTeam }
  })
}

// ─── CLI ────────────────────────────────────────────────────────────────────

export interface ProjectCliDeps {
  env?: NodeJS.ProcessEnv
  cwd?: string
  out?: (msg: string) => void
  err?: (msg: string) => void
  /** Restart the installed service so it reads the new config. Returns a line for the output. */
  restartService?: () => Promise<string>
}

const USAGE = `Usage:
  team-monitor project add <path> [--name <name>] [--no-restart]
  team-monitor project remove <id|path> [--no-restart]
  team-monitor project list`

export async function runProjectCli(argv: string[], deps: ProjectCliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log
  const err = deps.err ?? console.error
  const home = teamHome(deps.env ?? process.env)
  const cwd = deps.cwd ?? process.cwd()
  const [action, ...rest] = argv
  let name: string | undefined
  let restart = true
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--name' && rest[i + 1] !== undefined) { name = rest[++i] }
    else if (a === '--no-restart') restart = false
    else if (a.startsWith('--')) { err(`Unknown option ${a}\n${USAGE}`); return 2 }
    else positional.push(a)
  }

  const restartLine = async () => {
    if (!restart) { out('Not restarted (--no-restart): the running monitor picks this up at its next start.'); return }
    if (deps.restartService) out(await deps.restartService())
  }

  try {
    if (action === 'add' && positional.length === 1) {
      const r = addProject(home, positional[0], name, cwd)
      out(r.added ? `Added ${r.project.id} (${r.project.name}): ${r.project.path}` : `Already registered as ${r.project.id} (${r.project.name}): ${r.project.path}`)
      if (r.agentTeamCreated) out(`Created ${path.join(r.project.path, '.agent-team')}/`)
      if (r.exclude.file && r.exclude.added) out(`Added .agent-team/ to ${r.exclude.file}`)
      else if (!r.exclude.file) out('Not a git repo: nothing to exclude.')
      if (r.added || name) await restartLine()
      return 0
    }
    if (action === 'remove' && positional.length === 1) {
      const p = removeProject(home, positional[0], cwd)
      out(`Removed ${p.id} (${p.path}). Its .agent-team/ folder was left as it is.`)
      await restartLine()
      return 0
    }
    if (action === 'list' && positional.length === 0) {
      const list = listProjects(home)
      if (!list.length) { out(`No projects in ${configFile(home)}. Add one: team-monitor project add <path>`); return 0 }
      for (const p of list) {
        const note = !p.exists ? '  (folder missing)' : !p.hasAgentTeam ? '  (no .agent-team/ yet)' : ''
        out(`${p.id}\t${p.name}\t${p.path}${note}`)
      }
      return 0
    }
  } catch (e) {
    if (e instanceof ProjectError) { err(`Error: ${e.message}`); return 1 }
    throw e
  }
  err(USAGE)
  return 2
}
