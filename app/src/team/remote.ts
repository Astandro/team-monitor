/**
 * Remote (Tailscale) mode: where to bind and which Host names to accept.
 *
 * Architecture call A3: never 0.0.0.0 or `::`. Either 127.0.0.1 (behind
 * `tailscale serve`) or the machine's Tailscale IPv4 address (100.64.0.0/10).
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'

export const MAC_TAILSCALE_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

export type BindMode = 'tailscale' | 'loopback'

export class RemoteConfigError extends Error {}

/** Runs the tailscale CLI with the given args and returns stdout. Injected in tests. */
export type TailscaleRunner = (args: string[]) => string

export function defaultTailscaleBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEAM_MONITOR_TAILSCALE_BIN) return env.TEAM_MONITOR_TAILSCALE_BIN
  if (process.platform === 'darwin' && fs.existsSync(MAC_TAILSCALE_BIN)) return MAC_TAILSCALE_BIN
  return 'tailscale'
}

export function makeTailscaleRunner(bin: string): TailscaleRunner {
  return (args) => execFileSync(bin, args, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isTailnetIPv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip)
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (o.some((n) => n > 255)) return false
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127
}

/** Refuse any address remote mode must never listen on. Throws RemoteConfigError. */
export function assertSafeBindAddress(addr: string): void {
  const a = addr.trim().toLowerCase()
  if (a === '' || a === '0.0.0.0' || a === '::' || a === '[::]' || a === '0:0:0:0:0:0:0:0') {
    throw new RemoteConfigError(`Refusing to bind to "${addr || '(empty)'}": remote mode never listens on all interfaces.`)
  }
  if (a === '127.0.0.1') return
  if (!isTailnetIPv4(a)) {
    throw new RemoteConfigError(
      `Refusing to bind to "${addr}": it is not a Tailscale address (100.64.0.0/10) or 127.0.0.1.`,
    )
  }
}

export function getTailscaleIPv4(run: TailscaleRunner): string {
  let out: string
  try {
    out = run(['ip', '-4'])
  } catch (e) {
    throw new RemoteConfigError(
      `Could not run "tailscale ip -4" (${(e as Error).message.split('\n')[0]}). Is Tailscale installed and up? ` +
      'Set TEAM_MONITOR_TAILSCALE_BIN or --tailscale-bin to the CLI path.',
    )
  }
  const ip = out.split(/\s+/).find((s) => s.length > 0) ?? ''
  if (!ip) throw new RemoteConfigError('"tailscale ip -4" printed no address. Is Tailscale connected?')
  return ip
}

/** MagicDNS name of this machine without the trailing dot, or null. */
export function getTailscaleDNSName(run: TailscaleRunner): string | null {
  try {
    const status = JSON.parse(run(['status', '--json'])) as { Self?: { DNSName?: unknown } }
    const name = status.Self?.DNSName
    if (typeof name !== 'string' || !name) return null
    const clean = name.replace(/\.$/, '').toLowerCase()
    return /^[a-z0-9.-]+$/.test(clean) ? clean : null
  } catch {
    return null
  }
}

export interface RemoteConfig {
  bindMode: BindMode
  bindAddress: string
  tailscaleIp: string | null
  dnsName: string | null
  /** Host names (lowercase, without port) accepted besides loopback names. */
  allowedHosts: Set<string>
}

export interface ResolveRemoteOptions {
  bind: string | undefined
  hostAllow: string[]
  run: TailscaleRunner
  warn?: (msg: string) => void
}

export function resolveRemoteConfig(opts: ResolveRemoteOptions): RemoteConfig {
  const warn = opts.warn ?? console.warn
  const bind = (opts.bind ?? '').trim()
  if (!bind) throw new RemoteConfigError('--remote needs --bind tailscale or --bind loopback.')

  let bindMode: BindMode
  let bindAddress: string
  let tailscaleIp: string | null = null

  if (bind === 'tailscale') {
    bindMode = 'tailscale'
    tailscaleIp = getTailscaleIPv4(opts.run)
    assertSafeBindAddress(tailscaleIp)
    if (tailscaleIp === '127.0.0.1') throw new RemoteConfigError('tailscale ip -4 returned a loopback address.')
    bindAddress = tailscaleIp
  } else if (bind === 'loopback') {
    bindMode = 'loopback'
    bindAddress = '127.0.0.1'
    try { tailscaleIp = getTailscaleIPv4(opts.run) } catch { tailscaleIp = null }
    if (tailscaleIp && !isTailnetIPv4(tailscaleIp)) tailscaleIp = null
  } else {
    // Allow an explicit address only to give a clear refusal for unsafe ones.
    assertSafeBindAddress(bind)
    bindMode = bind === '127.0.0.1' ? 'loopback' : 'tailscale'
    bindAddress = bind
    tailscaleIp = bind === '127.0.0.1' ? null : bind
  }

  const dnsName = getTailscaleDNSName(opts.run)
  const allowedHosts = new Set<string>()
  if (tailscaleIp) allowedHosts.add(tailscaleIp)
  if (dnsName) {
    allowedHosts.add(dnsName)
    // MagicDNS also resolves the bare machine name (http://my-machine:3002).
    const short = dnsName.split('.')[0]
    if (short && short !== dnsName) allowedHosts.add(short)
  }
  for (const h of opts.hostAllow) {
    const clean = h.trim().toLowerCase().replace(/\.$/, '')
    if (!/^[a-z0-9.-]+$/.test(clean)) throw new RemoteConfigError(`--host-allow "${h}" is not a host name.`)
    allowedHosts.add(clean)
  }
  if (!dnsName) warn('[remote] MagicDNS name not found; add it with --host-allow <name>.ts.net if you use it.')
  return { bindMode, bindAddress, tailscaleIp, dnsName, allowedHosts }
}

/** Host header without the port, lowercase. Returns null for malformed values. */
export function hostName(host: string | undefined): string | null {
  if (typeof host !== 'string' || !host) return null
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    if (end < 0) return null
    const rest = h.slice(end + 1)
    if (rest && !/^:\d{1,5}$/.test(rest)) return null
    return h.slice(0, end + 1)
  }
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(h)
  return m ? m[1].replace(/\.$/, '') : null
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function isAllowedRemoteHost(host: string | undefined, cfg: RemoteConfig): boolean {
  const name = hostName(host)
  if (!name) return false
  return LOOPBACK_NAMES.has(name) || cfg.allowedHosts.has(name)
}
