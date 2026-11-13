import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { cleanAnswer, mapAnswerError, submitAnswer, type FetchLike } from './answer'

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = []
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return { status, json: async () => body }
  }
  return { fn, calls }
}

test('sends JSON with the CSRF header and same-origin credentials', async () => {
  const { fn, calls } = fakeFetch(200, { ok: true, answeredAt: '2026-11-13T10:00:00Z' })
  const r = await submitAnswer(fn, 'revamp-ui', 'D3', '  5 MB  ')
  assert.deepEqual(r, { ok: true, answeredAt: '2026-11-13T10:00:00Z' })
  assert.equal(calls[0].url, '/api/team/answer')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.equal(calls[0].init.headers['X-Team-Monitor'], '1')
  assert.deepEqual(JSON.parse(calls[0].init.body), { project: 'revamp-ui', id: 'D3', answer: '5 MB' })
})

test('blank or too long answers are refused before any request', async () => {
  const { fn, calls } = fakeFetch(200, { ok: true })
  assert.equal((await submitAnswer(fn, 'p', 'D1', '   ')).ok, false)
  assert.equal((await submitAnswer(fn, 'p', 'D1', 'x'.repeat(2001))).ok, false)
  assert.equal(calls.length, 0)
  assert.equal(cleanAnswer('x'.repeat(2000))?.length, 2000)
})

test('401 sends the user to login', async () => {
  const r = await submitAnswer(fakeFetch(401, { ok: false, error: 'login required' }).fn, 'p', 'D1', 'ya')
  assert.ok(!r.ok && r.kind === 'login' && r.status === 401)
})

test('409 says the decision was already answered', async () => {
  const r = await submitAnswer(fakeFetch(409, { ok: false, error: 'decision is not open' }).fn, 'p', 'D1', 'ya')
  assert.ok(!r.ok && r.kind === 'error')
  assert.equal(!r.ok && r.message, 'Keputusan ini sudah dijawab')
})

test('other failures show the server text in plain words', async () => {
  const r = await submitAnswer(fakeFetch(500, { ok: false, error: 'disk penuh' }).fn, 'p', 'D1', 'ya')
  assert.ok(!r.ok && r.message.includes('disk penuh'))
  assert.equal(mapAnswerError(500).message, 'Gagal kirim jawaban (kode 500).')
  assert.ok(mapAnswerError(429).message.includes('Tunggu sebentar'))
  assert.ok(mapAnswerError(403).message.includes('Muat ulang'))
  assert.ok(mapAnswerError(404).message.includes('nggak ada'))
})

test('a network failure or an unreadable body is reported, not thrown', async () => {
  const down: FetchLike = async () => {
    throw new TypeError('Failed to fetch')
  }
  const r = await submitAnswer(down, 'p', 'D1', 'ya')
  assert.ok(!r.ok && r.status === 0 && r.message.includes('nyambung'))
  const badBody: FetchLike = async () => ({
    status: 502,
    json: async () => {
      throw new SyntaxError('bad json')
    },
  })
  const r2 = await submitAnswer(badBody, 'p', 'D1', 'ya')
  assert.ok(!r2.ok && r2.status === 502)
})

test('a 200 that says ok:false is still a failure', async () => {
  const r = await submitAnswer(fakeFetch(200, { ok: false, error: 'aneh' }).fn, 'p', 'D1', 'ya')
  assert.equal(r.ok, false)
})
