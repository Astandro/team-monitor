/**
 * hub-client: proxy selection (HTTPS_PROXY / HTTP_PROXY / NO_PROXY) and requests through a local fake CONNECT
 * proxy, to a plain HTTP hub and to an HTTPS hub (self-signed certificate, made with openssl at test time).
 */
import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as path from 'path'
import type { AddressInfo } from 'net'
import { bypassesProxy, hubRequest, proxyFor } from './hub-client'
import { fakeConnectProxy, listen, makeTmpDir, removeTmpDir } from './test-helpers'

const tmp = makeTmpDir()
after(() => removeTmpDir(tmp))

function echoHandler(seen: Array<{ method?: string; url?: string; auth?: string; body: string }>): http.RequestListener {
  return (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  }
}

test('proxy selection follows HTTPS_PROXY, HTTP_PROXY and NO_PROXY', () => {
  const env = { HTTPS_PROXY: 'http://proxy.local:8080', HTTP_PROXY: 'http://plain.local:3128', NO_PROXY: 'localhost,127.0.0.1,.internal.example,*.corp.example,other.example:8443' }
  assert.equal(proxyFor(new URL('https://hub.example.net/x'), env)?.host, 'proxy.local:8080')
  assert.equal(proxyFor(new URL('http://hub.example.net/x'), env)?.host, 'plain.local:3128')
  assert.equal(proxyFor(new URL('https://localhost:3002/'), env), null)
  assert.equal(proxyFor(new URL('http://127.0.0.1:3002/'), env), null)
  assert.equal(bypassesProxy(new URL('https://a.internal.example/'), env), true)
  assert.equal(bypassesProxy(new URL('https://internal.example/'), env), true)
  assert.equal(bypassesProxy(new URL('https://b.corp.example/'), env), true)
  assert.equal(bypassesProxy(new URL('https://other.example:8443/'), env), true)
  assert.equal(bypassesProxy(new URL('https://other.example/'), env), false)
  assert.equal(bypassesProxy(new URL('https://notinternal.example/'), env), false)
  assert.equal(bypassesProxy(new URL('https://x.example/'), { NO_PROXY: '*' }), true)
  // lower-case variants are read too; no proxy variable at all means direct
  assert.equal(proxyFor(new URL('https://hub.example.net/'), { https_proxy: 'proxy.local:9' })?.href, 'http://proxy.local:9/')
  assert.equal(proxyFor(new URL('https://hub.example.net/'), {}), null)
  assert.throws(() => proxyFor(new URL('https://hub.example.net/'), { HTTPS_PROXY: 'socks5://p:1' }), /not supported/)
})

test('a request to an http hub goes through the CONNECT proxy and carries the Authorization header', async () => {
  const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = []
  const hub = await listen(echoHandler(seen))
  const proxy = await fakeConnectProxy()
  try {
    const r = await hubRequest({
      method: 'POST', url: `http://127.0.0.1:${hub.port}/api/ingest/v1/events?x=1`,
      headers: { Authorization: 'Bearer secret-value', 'Content-Type': 'application/json' }, body: '{"a":1}',
      env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` },
    })
    assert.equal(r.status, 200)
    assert.deepEqual(proxy.targets, [`127.0.0.1:${hub.port}`])
    assert.deepEqual(seen, [{ method: 'POST', url: '/api/ingest/v1/events?x=1', auth: 'Bearer secret-value', body: '{"a":1}' }])

    // NO_PROXY: straight to the hub, the proxy sees nothing new
    const r2 = await hubRequest({ method: 'GET', url: `http://127.0.0.1:${hub.port}/y`, env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: '127.0.0.1' } })
    assert.equal(r2.status, 200)
    assert.equal(proxy.targets.length, 1)
  } finally {
    await proxy.close()
    await hub.close()
  }
})

test('a refused tunnel rejects with a message that does not contain the token', async () => {
  const proxy = await fakeConnectProxy({ refuse: true })
  try {
    await assert.rejects(
      hubRequest({ method: 'GET', url: 'https://hub.invalid/x', headers: { Authorization: 'Bearer secret-value' }, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } }),
      (e: Error) => /refused the tunnel \(HTTP 403\)/.test(e.message) && !e.message.includes('secret-value'),
    )
  } finally {
    await proxy.close()
  }
})

test('timeouts and aborts reject', async () => {
  const hang = await listen(() => { /* never answers */ })
  try {
    await assert.rejects(hubRequest({ method: 'GET', url: `http://127.0.0.1:${hang.port}/`, timeoutMs: 150, env: {} }), /timed out/)
    const ac = new AbortController()
    const p = hubRequest({ method: 'GET', url: `http://127.0.0.1:${hang.port}/`, timeoutMs: 5000, env: {}, signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await assert.rejects(p, /aborted/)
  } finally {
    await hang.close()
  }
})

const haveOpenssl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

test('an https hub through the CONNECT proxy (TLS inside the tunnel, server name checked)', { skip: haveOpenssl ? false : 'openssl not installed' }, async () => {
  const key = path.join(tmp, 'key.pem')
  const cert = path.join(tmp, 'cert.pem')
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' })
  assert.equal(gen.status, 0)
  const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = []
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, echoHandler(seen))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  const proxy = await fakeConnectProxy()
  try {
    const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }
    const r = await hubRequest({ method: 'PUT', url: `https://localhost:${port}/api/ingest/v1/state`, headers: { Authorization: 'Bearer t' }, body: '{}', env, ca: fs.readFileSync(cert) })
    assert.equal(r.status, 200)
    assert.deepEqual(proxy.targets, [`localhost:${port}`])
    assert.equal(seen[0].url, '/api/ingest/v1/state')
    // without the CA the certificate is refused
    await assert.rejects(hubRequest({ method: 'GET', url: `https://localhost:${port}/`, env }), /TLS to the hub failed/)
  } finally {
    await proxy.close()
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
