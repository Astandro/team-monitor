import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  buildThread,
  ChatReplyTracker,
  chatStatusLabel,
  chatTime,
  cleanMessage,
  coordinatorName,
  counterText,
  enterSends,
  MAX_MESSAGE_LENGTH,
  pruneLocal,
  submitMessage,
  watcherNotice,
  type ChatEntry,
} from './chat'
import type { PostFetch } from './post'

const NOW = new Date(2026, 10, 13, 15, 0).getTime()
const at = (h: number, m: number, day = 13) => new Date(2026, 10, day, h, m).toISOString()

test('chatTime: clock today, date and clock on another day, empty when unreadable', () => {
  assert.equal(chatTime(at(14, 5), NOW), '14.05')
  assert.equal(chatTime(at(9, 30, 12), NOW), '12 Nov 09.30')
  assert.equal(chatTime('nope', NOW), '')
  assert.equal(chatTime(undefined, NOW), '')
})

test('status labels: sent is Terkirim, read is Dibaca <coordinator>', () => {
  assert.equal(chatStatusLabel('sent', 'Sora'), 'Terkirim')
  assert.equal(chatStatusLabel('read', 'Sora'), 'Dibaca Sora')
  assert.equal(chatStatusLabel(undefined, 'Sora'), '')
})

test('coordinatorName reads meta.coordinator.name, else Sora', () => {
  assert.equal(coordinatorName({ coordinator: { name: 'Haru', role: 'Orchestrator' } }), 'Haru')
  assert.equal(coordinatorName({ coordinator: { name: ' ' } }), 'Sora')
  assert.equal(coordinatorName(undefined), 'Sora')
})

const CHAT: ChatEntry[] = [
  { id: 'a1', from: 'owner', text: 'Halo\nbaris dua', t: at(14, 0), status: 'read', readAt: at(14, 1) },
  { id: 'r1', from: 'sora', text: 'Siap', t: at(14, 2) },
  { id: 'a2', from: 'owner', text: 'Satu lagi', t: at(14, 3), status: 'sent' },
]

test('buildThread keeps server order, who wrote it, line breaks, time and the owner status', () => {
  const items = buildThread(CHAT, { now: NOW, coordinatorName: 'Sora' })
  assert.deepEqual(
    items.map((i) => [i.id, i.mine, i.who, i.status, i.time]),
    [
      ['a1', true, 'Kamu', 'Dibaca Sora', '14.00'],
      ['r1', false, 'Sora', '', '14.02'],
      ['a2', true, 'Kamu', 'Terkirim', '14.03'],
    ],
  )
  assert.equal(items[0].text, 'Halo\nbaris dua')
  assert.equal(items[0].read, true)
  assert.equal(items[2].read, false)
})

test('buildThread appends sent messages the stream has not delivered, once', () => {
  const local = [
    { id: 'a2', text: 'Satu lagi', sentAt: at(14, 3) },
    { id: 'n9', text: 'Baru', sentAt: at(14, 9) },
  ]
  const items = buildThread(CHAT, { now: NOW, coordinatorName: 'Sora', local })
  assert.deepEqual(items.map((i) => i.id), ['a1', 'r1', 'a2', 'n9'])
  assert.equal(items[3].status, 'Terkirim')
  assert.deepEqual(pruneLocal(local, CHAT), [local[1]])
})

test('buildThread skips entries without text and survives a missing chat', () => {
  assert.deepEqual(buildThread([{ id: 'x', from: 'sora' }], { now: NOW, coordinatorName: 'Sora' }), [])
  assert.deepEqual(buildThread(undefined, { now: NOW, coordinatorName: 'Sora' }), [])
})

test('watcherNotice only when the server says the watcher is not alive', () => {
  assert.match(watcherNotice({ alive: false, since: null }, 'Sora'), /^Sora lagi nggak aktif, pesan disimpan/)
  assert.equal(watcherNotice({ alive: true }, 'Sora'), '')
  assert.equal(watcherNotice(undefined, 'Sora'), '')
})

test('counter appears near the limit only; cleanMessage matches the server rules', () => {
  assert.equal(counterText(3599), '')
  assert.equal(counterText(3600), '3600/4000')
  assert.equal(cleanMessage('  a\r\nb  '), 'a\nb')
  assert.equal(cleanMessage('   '), null)
  assert.equal(cleanMessage('x'.repeat(MAX_MESSAGE_LENGTH)), 'x'.repeat(MAX_MESSAGE_LENGTH))
  assert.equal(cleanMessage('x'.repeat(MAX_MESSAGE_LENGTH + 1)), null)
})

test('enterSends: Enter on desktop, never with Shift or on a touch keyboard or while composing', () => {
  assert.equal(enterSends({ key: 'Enter', shiftKey: false }, false), true)
  assert.equal(enterSends({ key: 'Enter', shiftKey: true }, false), false)
  assert.equal(enterSends({ key: 'Enter', shiftKey: false }, true), false)
  assert.equal(enterSends({ key: 'Enter', shiftKey: false, isComposing: true }, false), false)
  assert.equal(enterSends({ key: 'a', shiftKey: false }, false), false)
})

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: Parameters<PostFetch>[1] }[] = []
  const fn: PostFetch = async (url, init) => {
    calls.push({ url, init })
    return { status, json: async () => body, headers: { get: (n: string) => headers[n] ?? null } }
  }
  return { fn, calls }
}

test('submitMessage posts the cleaned text with the answer headers and returns id and sentAt', async () => {
  const f = fakeFetch(200, { ok: true, id: 'abc123', sentAt: at(14, 9) })
  const r = await submitMessage(f.fn, 'p1', '  hai\r\n')
  assert.deepEqual(r, { ok: true, id: 'abc123', sentAt: at(14, 9) })
  assert.equal(f.calls[0].url, '/api/team/message')
  assert.equal(f.calls[0].init.headers['X-Team-Monitor'], '1')
  assert.equal(f.calls[0].init.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { project: 'p1', text: 'hai' })
})

test('submitMessage: 429 says when to retry from Retry-After; 401 asks for login; blank is not sent', async () => {
  const limited = await submitMessage(fakeFetch(429, { ok: false, error: 'too many' }, { 'Retry-After': '48' }).fn, 'p', 'x')
  assert.equal(limited.ok, false)
  if (!limited.ok) {
    assert.equal(limited.kind, 'limit')
    assert.equal(limited.retryAfter, 48)
    assert.match(limited.message, /48 detik/)
  }
  const login = await submitMessage(fakeFetch(401, { ok: false }).fn, 'p', 'x')
  assert.equal(!login.ok && login.kind, 'login')
  const blank = fakeFetch(200, { ok: true, id: 'z' })
  const r = await submitMessage(blank.fn, 'p', '  ')
  assert.equal(r.ok, false)
  assert.equal(blank.calls.length, 0)
  const down: PostFetch = async () => {
    throw new Error('offline')
  }
  const off = await submitMessage(down, 'p', 'x')
  assert.equal(!off.ok && off.status, 0)
})

test('ChatReplyTracker: silent on first payload and after a switch, true once per new reply', () => {
  const t = new ChatReplyTracker()
  assert.equal(t.step('p', CHAT), false)
  assert.equal(t.step('p', CHAT), false)
  // a new owner message is not a reply
  assert.equal(t.step('p', [...CHAT, { id: 'a3', from: 'owner', text: 'x', status: 'sent' }]), false)
  const withReply = [...CHAT, { id: 'r2', from: 'sora', text: 'Oke' }]
  assert.equal(t.step('p', withReply), true)
  assert.equal(t.step('p', withReply), false)
  assert.equal(t.step('q', [...withReply, { id: 'r3', from: 'sora', text: 'lain' }]), false)
  // after a switch the first payload may come later: its old replies are not news either
  assert.equal(t.step('z', null), false)
  assert.equal(t.step('z', withReply), false)
  assert.equal(t.step('z', [...withReply, { id: 'r4', from: 'sora', text: 'baru' }]), true)
})

test('coordinatorName: the documented meta.coordinator, a string, meta.run.coordinator, the coordinator agent, else Sora', () => {
  assert.equal(coordinatorName({ coordinator: { name: 'Sora', role: 'Orchestrator' } }), 'Sora')
  assert.equal(coordinatorName({ coordinator: 'Wulan' }), 'Wulan')
  assert.equal(coordinatorName({ run: { coordinator: 'Wulan' } }), 'Wulan')
  assert.equal(coordinatorName({ run: { coordinator: { name: 'Wulan' } } }), 'Wulan')
  assert.equal(coordinatorName({}, { w: { nick: 'Wulan', desk: 'coordinator' }, x: { nick: 'Thorvald', desk: 'reviewer' } }), 'Wulan')
  assert.equal(coordinatorName({}, { x: { nick: 'Thorvald', desk: 'reviewer' } }), 'Sora')
  assert.equal(coordinatorName(undefined), 'Sora')
})
