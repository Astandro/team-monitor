import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serveStatic, MIME_TYPES } from './static'

function capture(url: string): { status: number; headers: Record<string, string> } {
  const out = { status: 0, headers: {} as Record<string, string> }
  const res = {
    writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.headers = headers ?? {} },
    end() {},
  }
  serveStatic({ url } as never, res as never)
  return out
}

test('the page shell is always revalidated, so phones pick up a new build', () => {
  const r = capture('/')
  assert.equal(r.status, 200)
  assert.equal(r.headers['Cache-Control'], 'no-cache')
})

test('sound files are served with audio types; other extensions stay refused', () => {
  assert.equal(MIME_TYPES['.ogg'], 'audio/ogg')
  assert.equal(MIME_TYPES['.mp3'], 'audio/mpeg')
  assert.equal(MIME_TYPES['.wav'], undefined)
  assert.equal(capture('/../../etc/passwd.ogg').status === 200, false, 'no path traversal')
  assert.equal(capture('/x.exe').status, 404)
})
