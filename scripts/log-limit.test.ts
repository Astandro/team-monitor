import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { LogLimiter, oneLine } from './log-limit'

function make(opts: { perKindPerInterval?: number; maxKeys?: number } = {}) {
  const lines: string[] = []
  const clock = { t: 1_000_000 }
  const lim = new LogLimiter((l) => lines.push(l), { now: () => clock.t, ...opts })
  return { lines, clock, lim }
}

test('one line per kind and source/client per minute; the suppressed count comes with the next line', () => {
  const { lines, clock, lim } = make()
  for (let i = 0; i < 500; i++) lim.line('key-mismatch', 'c1 box-a', 'refused box-a')
  assert.deepEqual(lines, ['refused box-a'])
  // Another source, another client, another kind: each gets its own line.
  lim.line('key-mismatch', 'c1 box-b', 'refused box-b')
  lim.line('key-mismatch', 'c2 box-a', 'refused box-a from c2')
  lim.line('token', 'c1 box-a', 'bad token')
  assert.equal(lines.length, 4)
  clock.t += 59_999
  assert.equal(lim.line('key-mismatch', 'c1 box-a', 'refused box-a'), false)
  clock.t += 1
  assert.equal(lim.line('key-mismatch', 'c1 box-a', 'refused box-a'), true)
  assert.equal(lines[4], 'refused box-a (500 more like it suppressed)')
  clock.t += 60_000
  lim.line('key-mismatch', 'c1 box-a', 'refused box-a')
  assert.equal(lines[5], 'refused box-a', 'no count when nothing was suppressed')
})

test('many sources or clients of one kind: at most N lines per minute, the rest counted on the next line', () => {
  const { lines, clock, lim } = make({ perKindPerInterval: 3 })
  for (let i = 0; i < 1000; i++) lim.line('token', `client-${i}`, `bad token from client-${i}`)
  assert.equal(lines.length, 3)
  clock.t += 60_000
  lim.line('token', 'client-x', 'bad token from client-x')
  assert.equal(lines[3], 'bad token from client-x (997 more of this kind from other sources or clients suppressed)')
  // Other kinds have their own budget.
  lim.line('capacity-sources', 'client-x', 'cap')
  assert.equal(lines.length, 5)
})

test('memory is bounded; counts of forgotten entries are not lost', () => {
  const { lines, lim } = make({ maxKeys: 10, perKindPerInterval: 1000 })
  lim.line('k', 'a', 'a')
  for (let i = 0; i < 7; i++) lim.line('k', 'a', 'a') // 7 suppressed for a
  for (let i = 0; i < 50; i++) lim.line('k', `w${i}`, `w${i}`)
  assert.ok(lim.size() <= 10, `remembered ${lim.size()}`)
  // `a` was forgotten first; its 7 went to the kind's count, reported on the next line of the kind.
  assert.equal(lines.filter((l) => / \(7 more of this kind from other sources or clients suppressed\)$/.test(l)).length, 1)
})

test('one line: control characters cannot start a new log line; long text is capped', () => {
  assert.equal(oneLine('a\nb\r c', 100), 'a b c')
  assert.equal(oneLine('x'.repeat(20), 5), 'xxxxx...')
  const { lines, lim } = make()
  lim.line('k', 'who\nfake', `line\n[ingest] forged ${'y'.repeat(5000)}`)
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes('\n'))
  assert.ok(lines[0].length < 1100)
})
