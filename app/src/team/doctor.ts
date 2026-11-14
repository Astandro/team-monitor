/**
 * `team-monitor doctor`: one look at everything the monitor needs after a reboot or on a new machine.
 * Read-only: it never changes Tailscale, the service or ~/.claude/settings.json; it prints the fix instead.
 * Exit code 0 when every check passes, 1 otherwise.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { teamHome } from './config'
import { HEALTH_PATH } from './http'
import { loadConfig, ProjectError, storedProjects } from './projects'
import { defaultTailscaleBin, makeTailscaleRunner, publicUiFunnelCommand, TailscaleRunner } from './remote'
import { readServiceRecord, ServiceDeps, serviceStatus } from './service'

export type CheckLevel = 'ok' | 'fail' | 'warn'
export interface Check { level: CheckLevel; what: string; fix?: string }

export interface DoctorDeps extends ServiceDeps {
  /** Tailscale CLI for `serve status --json` (injected in tests). */
  runTailscale?: TailscaleRunner
  /** ~/.claude/settings.json (read only). */
  settingsFile?: string
  httpsPort?: number
  /** Run the hub intake checks even when the installed service has no --ingest (`doctor --ingest`). */
  ingest?: boolean
  /** Monitor port for the intake checks when no service is installed (`doctor --port`). */
  port?: number
  /** Run the public UI checks even when the installed service has no --public-ui (`doctor --public-ui`). */
  publicUi?: boolean
}

const DEFAULT_HTTPS_PORT = 8443

// ─── Reading `tailscale serve status --json` ────────────────────────────────
//
// The exact JSON of a foreground Funnel (`tailscale funnel <port>` without --bg) and of a TCP Funnel (`--tcp`,
// `--tls-terminated-tcp`) was not verified against a real Tailscale, so the status is read defensively: the whole
// document is walked (bounded depth) and every web handler / TCP forward found anywhere is collected with the
// host:port (or port) key it hangs under and whether it sits in a foreground session; every `AllowFunnel` map found
// at any depth counts for every mapping (when unsure: public).

/** Deeper than any real serve status; deeper parts of a document are not read. */
const MAX_STATUS_DEPTH = 32
/** Keys of a serve config: a `Foreground` object holding these directly is one session without an id. */
const SERVE_CONFIG_KEYS = new Set(['TCP', 'Web', 'AllowFunnel', 'Services'])
/** A host:port key (`machine.ts.net:443`) or a bare port key (`443`, as under `TCP`). */
const SERVE_KEY_RE = /^(?:[^/]+:\d+|\d+)$/

interface ServeWeb {
  /** null: background config; a string: a foreground session ('' when it has no id). */
  scope: string | null
  /** The host:port (or port) key it hangs under; null when none was found. */
  key: string | null
  handlers: Array<{ mount: string; proxy: string }>
}
interface ServeTcp { scope: string | null; key: string | null; target: string; tls: boolean }
interface ServeStatus { webs: ServeWeb[]; tcp: ServeTcp[]; funnel: Set<string> }

/** `host:port` lower-cased without the DNS root dot, or the bare port; null for anything else. */
function parseServeKey(key: string): { host: string | null; port: string } | null {
  const m = /^(.*):(\d+)$/.exec(key)
  if (m) return { host: m[1] ? m[1].toLowerCase().replace(/\.$/, '') : null, port: m[2] }
  return /^\d+$/.test(key) ? { host: null, port: key } : null
}

function readServeStatus(statusJson: string): ServeStatus | null {
  let data: unknown
  try { data = JSON.parse(statusJson) } catch { return null }
  if (!data || typeof data !== 'object') return null
  const webs = new Map<string, ServeWeb>()
  const tcp: ServeTcp[] = []
  const funnel = new Set<string>()
  const web = (scope: string | null, key: string | null) => {
    const id = `${scope === null ? '-' : `fg:${scope}`}\0${key ?? ''}`
    let w = webs.get(id)
    if (!w) { w = { scope, key, handlers: [] }; webs.set(id, w) }
    return w
  }
  const funnelOn = (v: unknown) => v === true || v === 'true' || v === 1
  const addFunnel = (v: unknown) => {
    const keys = Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string')
      : v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).filter(([, on]) => funnelOn(on)).map(([k]) => k) : []
    for (const k of keys) {
      const p = parseServeKey(k.trim())
      if (p) funnel.add(p.host ? `${p.host}:${p.port}` : p.port)
    }
  }
  interface Ctx { scope: string | null; key: string | null; mount: string | null; fgParent: boolean }
  const walk = (node: unknown, ctx: Ctx, depth: number): void => {
    if (depth > MAX_STATUS_DEPTH || !node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      // An array directly under `Foreground`: one session per element.
      node.forEach((v, i) => walk(v, { ...ctx, scope: ctx.fgParent ? String(i) : ctx.scope, fgParent: false }, depth + 1))
      return
    }
    const obj = node as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      // Directly under `Foreground` the keys are session ids (or, defensively, the config keys themselves).
      const scope = ctx.fgParent ? (SERVE_CONFIG_KEYS.has(k) ? '' : k) : ctx.scope
      if (k === 'AllowFunnel') { addFunnel(v); continue }
      if (k === 'Handlers' && v && typeof v === 'object' && !Array.isArray(v)) {
        const w = web(scope, ctx.key)
        for (const [mount, h] of Object.entries(v as Record<string, unknown>)) {
          const proxy = h && typeof h === 'object' && typeof (h as { Proxy?: unknown }).Proxy === 'string' ? ((h as { Proxy: string }).Proxy).trim() : ''
          w.handlers.push({ mount, proxy })
        }
        continue
      }
      if (k === 'Proxy' && typeof v === 'string') {
        web(scope, ctx.key).handlers.push({ mount: ctx.mount ?? '/', proxy: v.trim() })
        continue
      }
      if (k === 'TCPForward' && typeof v === 'string') {
        const tls = obj.TerminateTLS
        tcp.push({ scope, key: ctx.key, target: v.trim(), tls: !!tls && tls !== 'false' })
        continue
      }
      if (k === 'Web' && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const hk of Object.keys(v)) if (SERVE_KEY_RE.test(hk)) web(scope, hk)
      }
      walk(v, {
        scope,
        key: !ctx.fgParent && SERVE_KEY_RE.test(k) ? k : ctx.key,
        mount: k.startsWith('/') ? k : ctx.mount,
        fgParent: k === 'Foreground',
      }, depth + 1)
    }
  }
  walk(data, { scope: null, key: null, mount: null, fgParent: false }, 0)
  return { webs: [...webs.values()], tcp, funnel }
}

/**
 * Funnel on for a mapping under `key`: its host:port is on in any AllowFunnel map; a port-only key (TCP entries)
 * matches any host with that port; no key at all: on when any Funnel is on (when unsure: public).
 */
function funnelOnFor(key: string | null, funnel: Set<string>): boolean {
  if (key === null) return funnel.size > 0
  const p = parseServeKey(key)
  if (!p) return funnel.size > 0
  if (p.host) return funnel.has(`${p.host}:${p.port}`) || funnel.has(p.port)
  return [...funnel].some((k) => k === p.port || k.endsWith(`:${p.port}`))
}

/** The https ports of tailnet-only (no Funnel) handlers to this monitor, in the background config or in foreground sessions. */
function tailnetServePorts(statusJson: string, port: number, foreground: boolean): string[] {
  const st = readServeStatus(statusJson)
  if (!st) return []
  const found = new Set<string>()
  const targetRe = new RegExp(`^(?:https?://)?(?:127\\.0\\.0\\.1|localhost)?:?${port}/?$`)
  for (const w of st.webs) {
    if ((w.scope !== null) !== foreground || funnelOnFor(w.key, st.funnel)) continue
    if (!w.handlers.some((h) => targetRe.test(h.proxy))) continue
    const m = w.key ? /:(\d+)$/.exec(w.key) : null
    found.add(m ? m[1] : w.key ?? '?')
  }
  return [...found]
}

/**
 * The https ports `tailscale serve` maps to 127.0.0.1:<port> / localhost:<port> on the TAILNET only, from
 * `serve status --json`, in the background config. A mapping with Funnel on (`AllowFunnel`, at any depth) is public
 * and never counted here (P-02): it is reported by the Funnel checks instead. Foreground sessions: see
 * foregroundServeMappings; TCP forwards are not https mappings and never counted.
 */
export function serveMappings(statusJson: string, port: number): string[] {
  return tailnetServePorts(statusJson, port, false)
}

/** As serveMappings, for foreground sessions (`tailscale serve <port>` without --bg): they end with that command. */
export function foregroundServeMappings(statusJson: string, port: number): string[] {
  return tailnetServePorts(statusJson, port, true)
}

/** A TCP forward to this monitor's port with Funnel on: raw TCP from the internet (no forwarded headers). */
export interface TcpFunnel {
  /** The host:port or port key it hangs under ('?' when none). */
  key: string
  /** The listening port, when known. */
  port: string | null
  /** The forward target as written in the status (e.g. `127.0.0.1:3002`). */
  target: string
  /** TLS terminated by Tailscale (`--tls-terminated-tcp`). */
  tls: boolean
  /** In a foreground session (ends with its `tailscale funnel` command). */
  foreground: boolean
}

/** Every Funnel-enabled TCP forward to this monitor's port (any host spelling the other checks accept, any scheme). */
export function tcpFunnels(statusJson: string, port: number): TcpFunnel[] {
  const st = readServeStatus(statusJson)
  if (!st) return []
  const re = new RegExp(`^(?:[a-z][a-z0-9+.-]*://)?(?:127\\.0\\.0\\.1|localhost|\\[::1\\])?:?${port}/?$`, 'i')
  return st.tcp
    .filter((t) => re.test(t.target) && funnelOnFor(t.key, st.funnel))
    .map((t) => ({
      key: t.key ?? '?',
      port: t.key ? parseServeKey(t.key)?.port ?? null : null,
      target: t.target,
      tls: t.tls,
      foreground: t.scope !== null,
    }))
}

/** Where a TCP Funnel listens, for the texts: `<host>:<port>`, or `port <port>`. */
export function tcpWhere(t: TcpFunnel): string {
  return t.key.includes(':') ? t.key : t.port ? `port ${t.port}` : 'an unknown port'
}

/** How to stop a foreground Funnel: end the command that runs it (no `off` command applies to it). */
export function foregroundStop(bin: string): string {
  const quoted = bin.includes(' ') ? `"${bin}"` : bin
  return `stop the "${quoted} funnel" command that runs it in the foreground (Ctrl+C in its terminal, or end that process)`
}

/** The command that removes a background TCP Funnel: `tailscale funnel --tcp=<port> off` (or `--tls-terminated-tcp`). */
export function tcpFunnelOffCommand(t: TcpFunnel, bin = 'tailscale'): string {
  const quoted = bin.includes(' ') ? `"${bin}"` : bin
  if (!t.port) return `${quoted} funnel reset`
  return `${quoted} funnel --${t.tls ? 'tls-terminated-tcp' : 'tcp'}=${t.port} off`
}

/** One FAIL per TCP Funnel to the monitor port: in every mode, `--public-ui` and `--ingest` included. */
export function tcpFunnelChecks(funnels: TcpFunnel[], port: number, bin: string): Check[] {
  return funnels.map((t) => ({
    level: 'fail' as const,
    what: `the monitor is reachable from the internet as raw TCP: tailscale funnel forwards TCP on ${tcpWhere(t)} to ${t.target}${t.tls ? ' (TLS terminated)' : ''}${t.foreground ? ' in the foreground' : ''}, the monitor port ${port}. Raw TCP carries no forwarded headers, so requests from the internet look like requests made on this machine. Never use a TCP Funnel (--tcp, --tls-terminated-tcp) for the monitor`,
    fix: t.foreground ? foregroundStop(bin) : `remove that TCP Funnel: ${tcpFunnelOffCommand(t, bin)}`,
  }))
}

/** TCP Funnel checks from the status; an unreadable status adds nothing here (the other Funnel checks report it). */
function tcpChecksFrom(port: number, bin: string, run: TailscaleRunner): Check[] {
  let json: string
  try { json = run(['serve', 'status', '--json']) } catch { return [] }
  return tcpFunnelChecks(tcpFunnels(json, port), port, bin)
}

export const INGEST_MOUNT = '/api/ingest'
const FUNNEL_PORTS = [443, 8443, 10000]

export interface FunnelEntry {
  /** `<host>:<https port>` key of the serve config. */
  hostPort: string
  /** AllowFunnel is on for it (public internet). */
  funnel: boolean
  /** It has a /api/ingest handler proxying to this monitor. */
  ingest: boolean
  /** Its `/` handler proxies to the root of this monitor (the whole app; `--public-ui`). Also listed in `others`. */
  root: boolean
  /** Its other mount paths (anything else on a Funnel port is public too). */
  others: string[]
  /** Every mount path whose handler proxies to this monitor's port (any target path), the ingest mount included. */
  mine: string[]
  /** It sits in a foreground session (`tailscale funnel|serve <port>` without --bg): it ends with that command. */
  foreground: boolean
}

/**
 * Per https host:port of `tailscale serve status --json`, in the background config and in every foreground session
 * (found at any depth): Funnel on or off (AllowFunnel at any depth), the ingest mount, other mounts.
 */
export function funnelEntries(statusJson: string, port: number): FunnelEntry[] {
  const st = readServeStatus(statusJson)
  if (!st) return []
  const targetRe = new RegExp(`^(?:https?://)?(?:127\\.0\\.0\\.1|localhost):${port}(?:/api/ingest)?/?$`)
  const rootRe = new RegExp(`^(?:https?://)?(?:127\\.0\\.0\\.1|localhost):${port}/?$`)
  const anyPathRe = new RegExp(`^(?:https?://)?(?:127\\.0\\.0\\.1|localhost|\\[::1\\])?:?${port}(?:[/?#].*)?$`, 'i')
  const out: FunnelEntry[] = []
  for (const w of st.webs) {
    let ingest = false
    let root = false
    const others: string[] = []
    const mine: string[] = []
    for (const { mount, proxy } of w.handlers) {
      if (mount.replace(/\/$/, '') === INGEST_MOUNT && targetRe.test(proxy)) ingest = true
      else others.push(mount)
      if (mount === '/' && rootRe.test(proxy)) root = true
      if (proxy && anyPathRe.test(proxy)) mine.push(mount)
    }
    out.push({ hostPort: w.key ?? '?', funnel: funnelOnFor(w.key, st.funnel), ingest, root, others, mine, foreground: w.scope !== null })
  }
  return out
}

/** One Funnel host:port that reaches this monitor on paths its flags do not allow. */
export interface FunnelExposure { hostPort: string; paths: string[]; foreground?: boolean }

/**
 * The mounts of this monitor (port `port`) on Funnel-enabled host:ports that are NOT expected for the given flags
 * (P-02/P-03): with `publicUi` nothing is unexpected (the whole app is meant to be public); with `ingest` only, every
 * mount except exactly `/api/ingest`; otherwise every mount. Used by doctor and by the start-up warning.
 */
export function unexpectedFunnelExposure(entries: FunnelEntry[], flags: { publicUi?: boolean; ingest?: boolean }): FunnelExposure[] {
  if (flags.publicUi) return []
  const out: FunnelExposure[] = []
  for (const e of entries) {
    if (!e.funnel) continue
    const paths = e.mine.filter((m) => !(flags.ingest && m.replace(/\/$/, '') === INGEST_MOUNT && e.ingest))
    if (paths.length) out.push(e.foreground ? { hostPort: e.hostPort, paths, foreground: true } : { hostPort: e.hostPort, paths })
  }
  return out
}

/** The command that turns one Funnel mount off: `tailscale funnel --https=<port> [--set-path <path>] off`. */
export function funnelOffCommand(hostPort: string, mount: string, bin = 'tailscale'): string {
  const quoted = bin.includes(' ') ? `"${bin}"` : bin
  const p = /:(\d+)$/.exec(hostPort)?.[1] ?? '443'
  return mount === '/' ? `${quoted} funnel --https=${p} off` : `${quoted} funnel --https=${p} --set-path ${mount} off`
}

/**
 * One doctor FAIL per exposed host:port: reachable from the internet, where, and the exact command(s) to stop it
 * (a foreground Funnel: end the command that runs it).
 */
export function exposureChecks(exposed: FunnelExposure[], port: number, bin: string): Check[] {
  return exposed.map((x) => ({
    level: 'fail' as const,
    what: `the monitor is reachable from the internet: tailscale funnel makes ${x.paths.join(', ')} on ${x.hostPort} public (to 127.0.0.1:${port}) without --public-ui`,
    fix: x.foreground
      ? `turn that Funnel mapping off: ${foregroundStop(bin)}`
      : `turn that Funnel mapping off: ${x.paths.map((m) => funnelOffCommand(x.hostPort, m, bin)).join(' ; ')}`,
  }))
}

/** The Funnel port doctor suggests: the first one Funnel allows that the tailnet UI (`--https-port`) does not use. */
function funnelPortFor(uiHttpsPort: number): number {
  return FUNNEL_PORTS.find((p) => p !== uiHttpsPort) ?? 10000
}

function ingestTokenCheck(home: string): Check {
  const tokenFile = path.join(home, 'ingest-token')
  const m = modeOf(tokenFile)
  if (m === null) return { level: 'fail', what: `ingest token file ${tokenFile} missing`, fix: 'it is created when the monitor starts with --ingest: team-monitor service restart' }
  if ((m & 0o077) !== 0) return { level: 'fail', what: `ingest token file is ${m.toString(8)}, should be 600`, fix: `chmod 600 "${tokenFile}"` }
  return { level: 'ok', what: 'ingest token file is 600' }
}

/**
 * Doctor checks for `--public-ui` (Addendum G): ONE Funnel mapping of the whole app (`/` -> http://127.0.0.1:<port>)
 * on a Funnel port. Missing: fail with the exact command. A public UI is the point here, so other mounts on the
 * Funnel port are not a failure, and with `ingest` the same mapping serves /api/ingest (no `--set-path` mapping is
 * asked for). A tailnet-only `tailscale serve` mapping (e.g. the phone's on 8443) is never flagged.
 */
export function publicUiChecks(port: number, uiHttpsPort: number, bin: string, run: TailscaleRunner, ingest: boolean): Check[] {
  const cmd = publicUiFunnelCommand(port, funnelPortFor(uiHttpsPort), bin)
  let entries: FunnelEntry[]
  try {
    entries = funnelEntries(run(['serve', 'status', '--json']), port)
  } catch (e) {
    return [{ level: 'fail', what: `cannot read tailscale serve status (${(e as Error).message.split('\n')[0]})`, fix: `is Tailscale up? then: ${cmd}` }]
  }
  // A TCP Funnel to the monitor port is a failure here too: raw TCP looks local (no forwarded headers).
  const tcp = tcpChecksFrom(port, bin, run)
  const roots = entries.filter((e) => e.funnel && e.root)
  if (!roots.length) {
    return [{ level: 'fail', what: `--public-ui: no tailscale funnel mapping of the whole app (/ to 127.0.0.1:${port})`, fix: cmd }, ...tcp]
  }
  const where = roots.map((e) => e.hostPort).join(', ')
  return [{
    level: 'ok',
    what: `tailscale funnel serves the whole app on ${where} (public UI: the login is on the internet${ingest ? `; it also serves ${INGEST_MOUNT}` : ''})`,
  }, ...tcp]
}

/** Doctor checks for the hub intake: ingest token file 0600, and a Funnel mapping that exposes only /api/ingest. */
export function ingestChecks(home: string, port: number, uiHttpsPort: number, bin: string, run: TailscaleRunner): Check[] {
  const checks: Check[] = [ingestTokenCheck(home)]

  const funnelPort = funnelPortFor(uiHttpsPort)
  const quoted = bin.includes(' ') ? `"${bin}"` : bin
  const cmd = `${quoted} funnel --bg --https=${funnelPort} --set-path ${INGEST_MOUNT} http://127.0.0.1:${port}${INGEST_MOUNT}`
  let entries: FunnelEntry[]
  try {
    entries = funnelEntries(run(['serve', 'status', '--json']), port)
  } catch (e) {
    checks.push({ level: 'fail', what: `cannot read tailscale serve status (${(e as Error).message.split('\n')[0]})`, fix: `is Tailscale up? then: ${cmd}` })
    return checks
  }
  const exposed = entries.filter((e) => e.funnel && e.ingest)
  if (!exposed.length) {
    checks.push({ level: 'fail', what: `no tailscale funnel mapping for ${INGEST_MOUNT} to 127.0.0.1:${port}`, fix: cmd })
  } else {
    checks.push({ level: 'ok', what: `tailscale funnel exposes ${INGEST_MOUNT} on ${exposed.map((e) => e.hostPort).join(', ')}` })
  }
  // Any other path of this monitor on a Funnel port: the monitor is reachable from the internet (P-02).
  checks.push(...exposureChecks(unexpectedFunnelExposure(entries, { ingest: true }), port, bin))
  // Other services' paths on the same Funnel port (as before).
  for (const e of entries.filter((x) => x.funnel)) {
    const foreign = e.others.filter((m) => !e.mine.includes(m))
    if (!foreign.length) continue
    checks.push({
      level: 'fail',
      what: `tailscale funnel makes ${foreign.join(', ')} on ${e.hostPort} public (the UI and login must stay tailnet-only)`,
      fix: `serve the UI on a port without Funnel (e.g. "${quoted} serve --bg --https=${uiHttpsPort} http://127.0.0.1:${port}") and keep only ${INGEST_MOUNT} on the Funnel port`,
    })
  }
  // A TCP Funnel to the monitor port: always a failure (raw TCP looks local).
  checks.push(...tcpChecksFrom(port, bin, run))
  return checks
}

/** A runner that runs each distinct command once (doctor reads `serve status` in more than one step). */
function memoRunner(run: TailscaleRunner): TailscaleRunner {
  const seen = new Map<string, { out?: string; err?: unknown }>()
  return (args) => {
    const k = args.join('\0')
    let r = seen.get(k)
    if (!r) {
      try { r = { out: run(args) } } catch (e) { r = { err: e } }
      seen.set(k, r)
    }
    if ('err' in r) throw r.err
    return r.out as string
  }
}

/**
 * Funnel check without --public-ui and without --ingest (P-02/P-03): no path of this monitor may be on a
 * Funnel-enabled host:port. No `tailscale` binary: nothing to check (no line). Status unreadable: a warning (unless
 * `reportUnreadable` is false because another step already failed on it).
 */
export function funnelChecks(port: number, bin: string, run: TailscaleRunner, reportUnreadable = true): Check[] {
  let json: string
  try {
    json = run(['serve', 'status', '--json'])
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || !reportUnreadable) return []
    return [{ level: 'warn', what: `cannot read tailscale serve status (${(e as Error).message.split('\n')[0]}): not checked whether Funnel exposes the monitor` }]
  }
  const exposed = unexpectedFunnelExposure(funnelEntries(json, port), {})
  const tcp = tcpFunnelChecks(tcpFunnels(json, port), port, bin)
  if (exposed.length || tcp.length) return [...exposureChecks(exposed, port, bin), ...tcp]
  return [{ level: 'ok', what: `no tailscale funnel mapping reaches 127.0.0.1:${port} (not public)` }]
}

/** The `ask-hook.js` path inside a hook command (quoted or not), or null. */
function askHookPath(command: string): string | null {
  const m = /"([^"]*ask-hook\.js)"|(\S*ask-hook\.js)/.exec(command)
  return m ? (m[1] ?? m[2]) : null
}

export function checkHooks(settingsFile: string): Check[] {
  let settings: { hooks?: Record<string, unknown> }
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as typeof settings
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
    return [{
      level: 'fail',
      what: `Claude Code settings ${settingsFile} ${missing ? 'missing' : 'cannot be read as JSON'}`,
      fix: 'start the monitor once (it writes the graph hooks), then add the AskUserQuestion hook (docs/coordinator.md 4b)',
    }]
  }
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  const commands = (event: string, matcher?: string): string[] => {
    const list = Array.isArray(hooks[event]) ? hooks[event] as Array<Record<string, unknown>> : []
    return list
      .filter((e) => matcher === undefined || e?.matcher === matcher)
      .flatMap((e) => Array.isArray(e?.hooks) ? e.hooks as Array<Record<string, unknown>> : [])
      .map((h) => typeof h?.command === 'string' ? h.command : '')
  }
  const out: Check[] = []
  const graphEvents = ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']
  const missingGraph = graphEvents.filter((ev) => !commands(ev).some((c) => c.includes('agent-flow/hook.js')))
  out.push(missingGraph.length
    ? { level: 'fail', what: `graph hooks missing in ${settingsFile} for ${missingGraph.join(', ')}`, fix: 'restart the monitor (it writes them at start): team-monitor service restart' }
    : { level: 'ok', what: 'graph hooks present in Claude Code settings' })
  const ask = commands('PreToolUse', 'AskUserQuestion').map(askHookPath).filter((p): p is string => !!p)
  if (!ask.length) {
    out.push({ level: 'fail', what: 'AskUserQuestion hook (ask-hook.js) missing in Claude Code settings', fix: 'add the snippet from docs/coordinator.md section 4b' })
  } else if (!ask.some((p) => fs.existsSync(p))) {
    out.push({ level: 'fail', what: `AskUserQuestion hook points at a missing file: ${ask[0]}`, fix: 'build the app (pnpm run build:app) or fix the path in the hook' })
  } else {
    out.push({ level: 'ok', what: 'AskUserQuestion hook present' })
  }
  return out
}

function modeOf(file: string): number | null {
  try { return fs.statSync(file).mode & 0o777 } catch { return null }
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<Check[]> {
  const env = deps.env ?? process.env
  const home = teamHome(env)
  const homedir = deps.homedir ?? os.homedir()
  const checks: Check[] = []
  const record = readServiceRecord(home)

  // 1. Build present (the one the service runs, else the one running this command).
  const appJs = record?.appJs ?? path.resolve(deps.appJs ?? process.argv[1] ?? '')
  const dist = path.dirname(appJs)
  // index.html is generated by static.ts; the build writes index.js and index.css.
  const missing = ['app.js', 'ask-hook.js', path.join('webview', 'index.js'), path.join('webview', 'index.css')].filter((f) => !fs.existsSync(path.join(dist, f)))
  checks.push(missing.length
    ? { level: 'fail', what: `build incomplete in ${dist}: missing ${missing.join(', ')}`, fix: 'npx -y pnpm@10 run build:app (in the team-monitor checkout)' }
    : { level: 'ok', what: `build present in ${dist}` })

  // 2-3. Service loaded and healthy.
  const st = await serviceStatus(deps)
  if (!st.record) {
    checks.push({ level: 'fail', what: 'service not installed', fix: 'node <checkout>/app/dist/app.js service install --remote --bind loopback' })
  } else {
    const r = st.record
    if (!st.installed) checks.push({ level: 'fail', what: `service file missing: ${r.file}`, fix: 'run service install again' })
    if (!st.manager.loaded || !st.manager.running) {
      checks.push({ level: 'fail', what: `service ${r.label} not running (${st.manager.detail})`, fix: `team-monitor service restart; log: ${r.logFile}` })
    } else {
      checks.push({ level: 'ok', what: `service ${r.label} running, pid ${st.manager.pid}` })
    }
    checks.push(st.health.ok
      ? { level: 'ok', what: `healthy: GET http://${r.listenHost}:${r.port}${HEALTH_PATH} 200` }
      : { level: 'fail', what: `not healthy on ${r.listenHost}:${r.port} (${st.listening ? `HTTP ${st.health.status}` : 'port not listening'})`, fix: `see the log: ${r.logFile}` })
  }

  // 4-5. Config and project folders.
  try {
    const projects = storedProjects(loadConfig(home))
    if (!projects.length) {
      checks.push({ level: 'fail', what: `no projects in ${path.join(home, 'config.json')}`, fix: 'team-monitor project add <path>' })
    } else {
      checks.push({ level: 'ok', what: `config valid, ${projects.length} project(s)` })
    }
    for (const p of projects) {
      const label = `project ${p.id || '(no id)'} (${p.path || 'no path'})`
      let isDir = false
      try { isDir = !!p.path && fs.statSync(p.path).isDirectory() } catch { isDir = false }
      if (!isDir) { checks.push({ level: 'fail', what: `${label}: folder missing`, fix: `team-monitor project remove ${p.id || p.path}` }); continue }
      let hasDir = false
      try { hasDir = fs.statSync(path.join(p.path, '.agent-team')).isDirectory() } catch { hasDir = false }
      checks.push(hasDir
        ? { level: 'ok', what: `${label}: .agent-team/ present` }
        : { level: 'fail', what: `${label}: .agent-team/ missing`, fix: `team-monitor project add ${p.path}` })
    }
  } catch (e) {
    if (!(e instanceof ProjectError)) throw e
    checks.push({ level: 'fail', what: `config invalid: ${e.message}` })
  }

  // Flags, port and the tailscale CLI for steps 6 and 8. `serve status` is read once per run.
  const ingestOn = !!(record?.ingest || deps.ingest)
  const publicUiOn = !!(record?.publicUi || deps.publicUi)
  const monitorPort = record?.port ?? deps.port ?? 3002
  const bin = record?.tailscaleBin || defaultTailscaleBin(env)
  const run = memoRunner(deps.runTailscale ?? makeTailscaleRunner(bin))

  // 6. Tailscale serve mapping on the tailnet (remote mode behind serve only). A Funnel host:port is never counted
  //    here (it is public: step 8). With --public-ui the Funnel root mapping serves the tailnet too, so a missing
  //    tailnet-only mapping is not a failure there.
  if (record?.remote && record.bind === 'loopback') {
    const httpsPort = deps.httpsPort ?? DEFAULT_HTTPS_PORT
    const cmd = `${bin.includes(' ') ? `"${bin}"` : bin} serve --bg --https=${httpsPort} http://127.0.0.1:${record.port}`
    try {
      const json = run(['serve', 'status', '--json'])
      const ports = serveMappings(json, record.port)
      const fgPorts = foregroundServeMappings(json, record.port)
      if (ports.length) checks.push({ level: 'ok', what: `tailscale serve maps https port ${ports.join(', ')} to 127.0.0.1:${record.port} (tailnet only)` })
      // A foreground serve (no --bg) is tailnet-only too, but ends with the command that runs it: said so.
      if (fgPorts.length) {
        checks.push({ level: 'ok', what: `tailscale serve maps https port ${fgPorts.join(', ')} to 127.0.0.1:${record.port} (tailnet only, in the foreground: it ends with the "tailscale serve" command that runs it)` })
      }
      if (!ports.length && !fgPorts.length && !publicUiOn) checks.push({ level: 'fail', what: `tailscale serve has no tailnet-only mapping to 127.0.0.1:${record.port}`, fix: cmd })
    } catch (e) {
      checks.push({ level: 'fail', what: `cannot read tailscale serve status (${(e as Error).message.split('\n')[0]})`, fix: `is Tailscale up? then: ${cmd}` })
    }
  }

  // 7. Home and token file permissions.
  const homeMode = modeOf(home)
  if (homeMode !== null && (homeMode & 0o077) !== 0) {
    checks.push({ level: 'fail', what: `${home} is ${homeMode.toString(8)}, should be 700`, fix: `chmod 700 "${home}"` })
  }
  if (record?.remote) {
    const tokenFile = path.join(home, 'token')
    const m = modeOf(tokenFile)
    if (m === null) checks.push({ level: 'fail', what: `token file ${tokenFile} missing`, fix: 'it is created when the monitor starts in remote mode: team-monitor service restart' })
    else if ((m & 0o077) !== 0) checks.push({ level: 'fail', what: `token file is ${m.toString(8)}, should be 600`, fix: `chmod 600 "${tokenFile}"` })
    else checks.push({ level: 'ok', what: 'token file is 600' })
  }

  // 8. Funnel, in every mode (P-02/P-03).
  //    --public-ui (on the service, or doctor --public-ui): the whole-app mapping is expected (it also serves
  //    /api/ingest); the ingest token file is still checked when ingest is on.
  //    --ingest only: token file and exactly the /api/ingest mount on Funnel.
  //    Neither: any path of this monitor on a Funnel host:port fails, with the command that turns it off.
  const uiHttpsPort = deps.httpsPort ?? DEFAULT_HTTPS_PORT
  if (publicUiOn) {
    if (ingestOn) checks.push(ingestTokenCheck(home))
    checks.push(...publicUiChecks(monitorPort, uiHttpsPort, bin, run, ingestOn))
  } else if (ingestOn) {
    checks.push(...ingestChecks(home, monitorPort, uiHttpsPort, bin, run))
  } else {
    // A failure to read the status was already reported by step 6 in remote mode behind serve.
    checks.push(...funnelChecks(monitorPort, bin, run, !(record?.remote && record.bind === 'loopback')))
  }

  // 9. Claude Code hooks (read only).
  checks.push(...checkHooks(deps.settingsFile ?? path.join(homedir, '.claude', 'settings.json')))
  return checks
}

export async function runDoctorCli(argv: string[], deps: DoctorDeps = {}): Promise<number> {
  const out = deps.out ?? console.log
  const err = deps.err ?? console.error
  let httpsPort = deps.httpsPort
  let ingest = deps.ingest
  let publicUi = deps.publicUi
  let port = deps.port
  const portArg = (v: string | undefined) => /^\d+$/.test(v ?? '') && Number(v) >= 1 && Number(v) <= 65535
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--https-port' && portArg(argv[i + 1])) {
      httpsPort = Number(argv[++i])
    } else if (argv[i] === '--port' && portArg(argv[i + 1])) {
      port = Number(argv[++i])
    } else if (argv[i] === '--ingest') {
      ingest = true
    } else if (argv[i] === '--public-ui') {
      publicUi = true
    } else {
      err('Usage: team-monitor doctor [--https-port <port for tailscale serve, default 8443>] [--ingest] [--public-ui] [--port <monitor port>]')
      return 2
    }
  }
  const checks = await runDoctor({ ...deps, httpsPort, ingest, port, publicUi })
  for (const c of checks) {
    out(`${c.level === 'ok' ? 'OK  ' : c.level === 'warn' ? 'WARN' : 'FAIL'}  ${c.what}`)
    if (c.fix && c.level !== 'ok') out(`      fix: ${c.fix}`)
  }
  const failed = checks.filter((c) => c.level === 'fail').length
  out(failed ? `\n${failed} problem(s).` : '\nAll good.')
  return failed ? 1 : 0
}
