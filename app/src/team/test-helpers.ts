/** Shared helpers for the team monitor tests (not a test file itself). */
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'net'

const PREFIX = 'tm-test-'

export function makeTmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
}

/** Remove a dir made by makeTmpDir, refusing anything else. */
export function removeTmpDir(dir: string): void {
  const root = fs.realpathSync(os.tmpdir())
  if (!dir || !path.isAbsolute(dir)) throw new Error(`refusing to remove ${dir}`)
  const resolved = path.resolve(dir)
  if (!resolved.startsWith(root + path.sep) || !path.basename(resolved).startsWith(PREFIX)) {
    throw new Error(`refusing to remove ${dir}: not a test temp dir`)
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}

export function sampleState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { title: 'Proyek uji', status: 'running', updatedAt: '2026-11-13T00:00:00.000Z' },
    stages: {},
    tasks: {},
    agents: {},
    approvals: {
      D1: { title: 'Pilih nama', question: 'Nama repo?', options: ['a', 'b'], status: 'open', order: 1 },
      D2: { title: 'Sudah', question: 'x', options: [], status: 'answered', answer: 'ya', order: 2 },
    },
    log: {},
    ...overrides,
  }
}

/** Create <root>/<name>/.agent-team/state.json and return the project path. */
export function makeProject(root: string, name: string, state: unknown = sampleState()): string {
  const p = path.join(root, name)
  fs.mkdirSync(path.join(p, '.agent-team'), { recursive: true })
  if (state !== undefined) writeState(p, state)
  return p
}

export function writeState(projectPath: string, state: unknown): void {
  const file = path.join(projectPath, '.agent-team', 'state.json')
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, typeof state === 'string' ? state : JSON.stringify(state))
  fs.renameSync(tmp, file)
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

export async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    server,
    port,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }),
  }
}

export interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }

export function request(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: opts.method ?? 'GET',
      path: opts.path,
      headers: { Host: `127.0.0.1:${port}`, ...opts.headers },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }))
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}
