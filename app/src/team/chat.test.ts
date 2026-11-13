import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  buildChat, ChatError, inboxFileName, INBOX_FILE_RE, listInbox, MAX_MESSAGE_CHARS, MessageLimiter,
  parseMessageBody, readMessageIds, readUnread, writeInboxMessage,
} from './chat'
import { makeTmpDir, removeTmpDir } from './test-helpers'

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = makeTmpDir()
    try { await fn(dir) } finally {
      try { fs.chmodSync(path.join(dir, 'inbox'), 0o700) } catch { /* not there */ }
      removeTmpDir(dir)
    }
  }
}

const status = (fn: () => unknown): number | undefined => {
  try { fn() } catch (e) { return e instanceof ChatError ? e.status : -1 }
  return undefined
}

test('parseMessageBody: keeps line breaks, trims, refuses bad input with 400', () => {
  assert.deepEqual(parseMessageBody({ project: 'p', text: '  halo\r\nSora\rlagi  \n' }), { project: 'p', text: 'halo\nSora\nlagi' })
  assert.equal(parseMessageBody({ project: 'p', text: 'x'.repeat(MAX_MESSAGE_CHARS) }).text.length, MAX_MESSAGE_CHARS)
  const bad: unknown[] = [
    null, [1], 'text', { text: 'x' }, { project: '', text: 'x' }, { project: 'p' }, { project: 'p', text: 5 },
    { project: 'p', text: ' \n\t ' }, { project: 'p', text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) },
  ]
  for (const b of bad) assert.equal(status(() => parseMessageBody(b)), 400, JSON.stringify(b))
})

test('MessageLimiter: 20 a minute, then a Retry-After until the oldest leaves the window', () => {
  const clock = { t: 1_000_000 }
  const lim = new MessageLimiter(20, 60_000, () => clock.t)
  for (let i = 0; i < 20; i++) {
    assert.equal(lim.retryAfter(), 0, `message ${i + 1}`)
    lim.record()
    clock.t += 1000
  }
  // 20 sent at t0..t0+19s; now t0+20s.
  assert.equal(lim.retryAfter(), 40)
  clock.t += 39_500
  assert.equal(lim.retryAfter(), 1)
  clock.t += 500
  assert.equal(lim.retryAfter(), 0, 'the first message left the window')
})

test('inbox file names sort by time and match the pattern', () => {
  const a = inboxFileName('0123456789ab', Date.parse('2026-11-13T01:00:00.000Z'))
  const b = inboxFileName('000000000000', Date.parse('2026-11-13T01:00:01.000Z'))
  assert.match(a, INBOX_FILE_RE)
  assert.ok(a < b)
  assert.equal(status(() => inboxFileName('../x', 1)), 400)
})

test('writeInboxMessage writes {id, text, sentAt} atomically, 0600, no temp file left', withDir((dir) => {
  const inbox = path.join(dir, 'inbox')
  const at = new Date('2026-11-13T05:06:07.890Z')
  const r = writeInboxMessage(inbox, 'halo\nSora', () => at)
  assert.equal(r.sentAt, at.toISOString())
  const names = fs.readdirSync(inbox)
  assert.deepEqual(names, [`${at.getTime()}-${r.id}.json`])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(inbox, names[0]), 'utf-8')), { id: r.id, text: 'halo\nSora', sentAt: r.sentAt })
  assert.equal(fs.statSync(path.join(inbox, names[0])).mode & 0o077, 0)
  assert.equal(fs.statSync(inbox).mode & 0o077, 0, 'inbox folder is 0700')
  const r2 = writeInboxMessage(inbox, 'dua', () => at)
  assert.notEqual(r2.id, r.id, 'two messages in the same millisecond do not collide')
  assert.equal(fs.readdirSync(inbox).length, 2)
}))

test('writeInboxMessage refuses a symlinked inbox: 500, nothing written at the target', withDir((dir) => {
  const outside = path.join(dir, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(dir, 'inbox'))
  let err: unknown
  try { writeInboxMessage(path.join(dir, 'inbox'), 'x') } catch (e) { err = e }
  assert.ok(err instanceof ChatError)
  assert.equal((err as ChatError).status, 500)
  assert.equal((err as ChatError).message, 'cannot save message')
  assert.ok(!(err as ChatError).message.includes('/'), 'no path for the client')
  assert.deepEqual(fs.readdirSync(outside), [])
}))

test('writeInboxMessage: a failed write leaves no file behind', withDir((dir) => {
  const inbox = path.join(dir, 'inbox')
  fs.mkdirSync(inbox, { mode: 0o700 })
  fs.chmodSync(inbox, 0o500)
  assert.equal(status(() => writeInboxMessage(inbox, 'x')), 500)
  fs.chmodSync(inbox, 0o700)
  assert.deepEqual(fs.readdirSync(inbox), [])
}))

test('listInbox ignores temp files and other names', withDir((dir) => {
  const inbox = path.join(dir, 'inbox')
  const r = writeInboxMessage(inbox, 'x', () => new Date(1_700_000_000_000))
  fs.writeFileSync(path.join(inbox, '.abc.json.123.tmp'), '{}')
  fs.writeFileSync(path.join(inbox, 'notes.json'), '{}')
  fs.writeFileSync(path.join(inbox, '1700000000000-XYZ.json'), '{}')
  assert.deepEqual(listInbox(inbox).map((f) => f.id), [r.id])
}))

test('read/unread: a message is read once state.json has chat.<id> with from "owner"', withDir((dir) => {
  const inbox = path.join(dir, 'inbox')
  const a = writeInboxMessage(inbox, 'satu', () => new Date('2026-11-13T01:00:00.000Z'))
  const b = writeInboxMessage(inbox, 'dua', () => new Date('2026-11-13T01:00:05.000Z'))
  assert.deepEqual(readUnread(inbox, null).map((m) => m.text), ['satu', 'dua'])
  const state = { chat: { [a.id]: { from: 'owner', text: 'satu', t: a.sentAt }, [b.id]: { from: 'sora', text: 'bukan owner', t: b.sentAt } } }
  assert.deepEqual([...readMessageIds(state)], [a.id])
  assert.deepEqual(readUnread(inbox, state).map((m) => m.id), [b.id], 'only an owner entry marks a message read')
}))

test('readUnread skips a file whose id does not match its name, or that is not a file', withDir((dir) => {
  const inbox = path.join(dir, 'inbox')
  fs.mkdirSync(inbox)
  fs.writeFileSync(path.join(inbox, '1700000000000-aaaaaaaaaaaa.json'), JSON.stringify({ id: 'bbbbbbbbbbbb', text: 'x', sentAt: 'y' }))
  fs.mkdirSync(path.join(inbox, '1700000000001-cccccccccccc.json'))
  assert.deepEqual(readUnread(inbox, null), [])
}))

test('buildChat: state entries plus unread messages, sorted by time, with status', () => {
  const state = {
    chat: {
      r2: { from: 'sora', text: 'balasan kedua', t: '2026-11-13T01:00:20.000Z' },
      m1: { from: 'owner', text: 'pesan satu', t: '2026-11-13T01:00:00.000Z', readAt: '2026-11-13T01:00:10.000Z' },
      r1: { from: 'sora', text: 'balasan satu', t: '2026-11-13T01:00:10.000Z' },
      junk1: { from: 'sora', t: '2026-11-13T01:00:00.000Z' },
      junk2: 'teks',
      junk3: { from: '', text: 'x', t: '2026-11-13T01:00:00.000Z' },
    },
  }
  const unread = [
    { id: 'm3', text: 'pesan tiga', sentAt: '2026-11-13T01:00:30.000Z' },
    { id: 'm2', text: 'pesan dua', sentAt: '2026-11-13T01:00:15.000Z' },
    { id: 'm1', text: 'pesan satu (inbox)', sentAt: '2026-11-13T01:00:00.000Z' },
  ]
  const chat = buildChat(state, unread)
  assert.deepEqual(chat.map((e) => e.id), ['m1', 'r1', 'm2', 'r2', 'm3'])
  assert.deepEqual(chat[0], { id: 'm1', from: 'owner', text: 'pesan satu', t: '2026-11-13T01:00:00.000Z', status: 'read', readAt: '2026-11-13T01:00:10.000Z' })
  assert.deepEqual(chat[1], { id: 'r1', from: 'sora', text: 'balasan satu', t: '2026-11-13T01:00:10.000Z' })
  assert.deepEqual(chat[2], { id: 'm2', from: 'owner', text: 'pesan dua', t: '2026-11-13T01:00:15.000Z', status: 'sent' })
})

test('buildChat: an owner entry without a time takes it from its inbox file name; no time sorts last', () => {
  const state = { chat: { aaaaaaaaaaaa: { from: 'owner', text: 'x' }, z: { from: 'sora', text: 'tanpa waktu' }, y: { from: 'sora', text: 'b', t: '2026-11-13T00:00:00.000Z' } } }
  const files = [{ name: '', id: 'aaaaaaaaaaaa', sentAtMs: Date.parse('2026-11-12T00:00:00.000Z') }]
  const chat = buildChat(state, [], files)
  assert.deepEqual(chat.map((e) => [e.id, e.t]), [
    ['aaaaaaaaaaaa', '2026-11-12T00:00:00.000Z'], ['y', '2026-11-13T00:00:00.000Z'], ['z', ''],
  ])
  assert.deepEqual(buildChat(null, []), [])
  assert.deepEqual(buildChat({ chat: [1, 2] }, []), [], 'a chat array is ignored')
})
