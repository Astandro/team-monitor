/**
 * HTTP(S) requests from a cloud container to the hub, honouring HTTPS_PROXY / HTTP_PROXY / NO_PROXY.
 *
 * Node's built-in fetch ignores the proxy variables, and a cloud container reaches the internet only through the
 * platform's proxy (HTTPS_PROXY, custom CA in NODE_EXTRA_CA_CERTS, which Node's TLS reads by itself). So this opens
 * a CONNECT tunnel through the proxy (http:// proxy URLs only) and speaks TLS to the hub inside it: the proxy sees
 * the target host and port, the request itself is end-to-end TLS to the hub (or plain HTTP for an http:// hub).
 *
 * Headers are never logged or put into error messages (the Authorization header carries the token).
 */
import * as http from 'http'
import * as https from 'https'
import * as net from 'net'
import * as tls from 'tls'

export interface HubRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  /** Whole request, connect to last body byte (default 30 s). */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Extra trusted CA (tests). In a container NODE_EXTRA_CA_CERTS already covers the proxy's CA. */
  ca?: string | Buffer
  /** Aborts the request (rejects with "aborted"). */
  signal?: AbortSignal
}

export interface HubResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

/** Largest response body read (an outbox reply holds at most 200 small files). */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export class HubRequestError extends Error {}

function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name] ?? env[name.toLowerCase()]
  return v && v.trim() ? v.trim() : undefined
}

function defaultPort(u: URL): number {
  if (u.port) return Number(u.port)
  return u.protocol === 'https:' ? 443 : 80
}

/** Host name without IPv6 brackets, lower case. */
function bareHost(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

/**
 * True when NO_PROXY (or no_proxy) says `target` goes direct: `*`, an exact host, a domain suffix (`example.com`,
 * `.example.com` or `*.example.com` all match `a.example.com`), each optionally with `:port`.
 */
export function bypassesProxy(target: URL, env: NodeJS.ProcessEnv): boolean {
  const list = envVar(env, 'NO_PROXY')
  if (!list) return false
  const host = bareHost(target)
  const port = defaultPort(target)
  for (const raw of list.split(/[,\s]+/)) {
    let entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    let entryPort: number | null = null
    const m = /^(.*?):(\d+)$/.exec(entry)
    if (m && !m[1].includes(':')) { entry = m[1]; entryPort = Number(m[2]) }
    entry = entry.replace(/^\[|\]$/g, '').replace(/^\*?\./, '')
    if (!entry) continue
    if (entryPort !== null && entryPort !== port) continue
    if (host === entry || host.endsWith('.' + entry)) return true
  }
  return false
}

/** The proxy to use for `target`, or null for a direct connection. */
export function proxyFor(target: URL, env: NodeJS.ProcessEnv): URL | null {
  const raw = target.protocol === 'https:' ? envVar(env, 'HTTPS_PROXY') : envVar(env, 'HTTP_PROXY')
  if (!raw || bypassesProxy(target, env)) return null
  let proxy: URL
  try { proxy = new URL(raw.includes('://') ? raw : `http://${raw}`) } catch { throw new HubRequestError('the proxy URL in the environment is not valid') }
  if (proxy.protocol !== 'http:') throw new HubRequestError(`proxy protocol ${proxy.protocol} is not supported (http:// only)`)
  return proxy
}

/** Open a CONNECT tunnel to host:port through `proxy`. */
function connectTunnel(proxy: URL, host: string, port: number, signal: { onAbort: (fn: () => void) => void }): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`
    const headers: Record<string, string> = { Host: authority }
    if (proxy.username || proxy.password) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`
    }
    const req = http.request({
      host: bareHost(proxy), port: defaultPort(proxy), method: 'CONNECT', path: authority, headers, agent: false,
    })
    signal.onAbort(() => req.destroy(new Error('aborted')))
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new HubRequestError(`proxy refused the tunnel (HTTP ${res.statusCode})`))
        return
      }
      if (head && head.length) socket.unshift(head)
      resolve(socket)
    })
    req.once('error', (e) => reject(new HubRequestError(`proxy connection failed: ${e.message}`)))
    req.end()
  })
}

function startTls(socket: net.Socket, host: string, ca: string | Buffer | undefined): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const opts: tls.ConnectionOptions = { socket, ...(net.isIP(host) ? {} : { servername: host }) }
    if (ca) opts.ca = [...tls.rootCertificates, ca.toString()]
    const t = tls.connect(opts)
    t.once('secureConnect', () => resolve(t))
    t.once('error', (e) => { socket.destroy(); reject(new HubRequestError(`TLS to the hub failed: ${e.message}`)) })
    t.once('close', () => reject(new HubRequestError('connection closed during the TLS handshake')))
  })
}

/** One request to the hub. Resolves with any HTTP status; rejects on network, proxy, TLS or timeout errors. */
export async function hubRequest(r: HubRequest): Promise<HubResponse> {
  const env = r.env ?? process.env
  let target: URL
  try { target = new URL(r.url) } catch { throw new HubRequestError('hub URL is not valid') }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new HubRequestError('hub URL must be http:// or https://')
  const proxy = proxyFor(target, env)
  const host = bareHost(target)
  const port = defaultPort(target)
  const timeoutMs = r.timeoutMs ?? 30_000

  const aborters: Array<() => void> = []
  let timedOut = false
  /** The tunnel (or TLS over it) is ours to close once the response is read. */
  let tunnelSock: net.Socket | null = null
  let reason = 'timed out'
  const abortAll = () => { timedOut = true; for (const fn of aborters.splice(0)) fn() }
  const timer = setTimeout(abortAll, timeoutMs)
  const onExternalAbort = () => { reason = 'aborted'; abortAll() }
  if (r.signal?.aborted) { clearTimeout(timer); throw new HubRequestError('aborted') }
  r.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const signal = { onAbort: (fn: () => void) => { if (timedOut) fn(); else aborters.push(fn) } }
  try {
    const headers: Record<string, string> = { ...r.headers, Host: target.host }
    if (r.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(r.body))
    const base: http.RequestOptions = {
      method: r.method, path: `${target.pathname}${target.search}`, headers,
    }

    let req: http.ClientRequest
    if (proxy) {
      const tunnel = await connectTunnel(proxy, host, port, signal)
      signal.onAbort(() => tunnel.destroy())
      tunnelSock = tunnel
      const sock: net.Socket = target.protocol === 'https:' ? await startTls(tunnel, host, r.ca) : tunnel
      tunnelSock = sock
      signal.onAbort(() => sock.destroy())
      req = http.request({ ...base, createConnection: () => sock })
    } else if (target.protocol === 'https:') {
      req = https.request({ ...base, host, port, agent: false, ...(r.ca ? { ca: [...tls.rootCertificates, r.ca.toString()] } : {}) })
    } else {
      req = http.request({ ...base, host, port, agent: false })
    }
    signal.onAbort(() => req.destroy(new HubRequestError(reason)))

    return await new Promise<HubResponse>((resolve, reject) => {
      req.once('response', (res) => {
        const chunks: Buffer[] = []
        let size = 0
        let ended = false
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_RESPONSE_BYTES) { req.destroy(new HubRequestError('hub response too large')); return }
          chunks.push(c)
        })
        res.once('end', () => {
          ended = true
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') })
        })
        res.once('error', (e) => reject(e))
        res.once('close', () => { if (!ended) reject(new HubRequestError('connection closed before the response ended')) })
      })
      req.once('error', (e) => reject(timedOut ? new HubRequestError(reason) : e))
      if (r.body !== undefined) req.write(r.body)
      req.end()
    })
  } catch (e) {
    if (timedOut) throw new HubRequestError(reason)
    throw e instanceof HubRequestError ? e : new HubRequestError((e as Error).message)
  } finally {
    clearTimeout(timer)
    r.signal?.removeEventListener('abort', onExternalAbort)
    tunnelSock?.destroy()
  }
}
