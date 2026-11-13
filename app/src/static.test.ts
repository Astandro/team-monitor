import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serveStatic } from './static'

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
