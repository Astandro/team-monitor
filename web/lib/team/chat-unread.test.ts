import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  nextSeenMarks,
  parseSeenMarks,
  seenMark,
  storeSeenMarks,
  unreadBadge,
  unreadCount,
  unreadLabel,
  type SeenMarks,
} from './chat-unread'
import type { ChatEntry } from './chat'

const NOW = '2026-11-13T15:00:00.000Z'
const own = (id: string, t: string): ChatEntry => ({ id, from: 'owner', text: 'halo', t, status: 'sent' })
const reply = (id: string, t: string): ChatEntry => ({ id, from: 'sora', text: 'oke', t })

const base: ChatEntry[] = [own('m1', '2026-11-13T14:00:00Z'), reply('r1', '2026-11-13T14:01:00Z')]

test('the mark is the newest coordinator reply, never an owner message', () => {
  const chat = [...base, own('m2', '2026-11-13T14:05:00Z')]
  assert.deepEqual(seenMark(chat, NOW), { id: 'r1', t: '2026-11-13T14:01:00Z' })
})

test('with no reply yet the mark is the newest entry time (or now)', () => {
  assert.deepEqual(seenMark([own('m1', '2026-11-13T14:00:00Z')], NOW), { id: '', t: '2026-11-13T14:00:00Z' })
  assert.deepEqual(seenMark([], NOW), { id: '', t: NOW })
  assert.deepEqual(seenMark(null, NOW), { id: '', t: NOW })
})

test('unread = replies after the marked one, owner messages do not count', () => {
  const mark = seenMark(base, NOW)
  assert.equal(unreadCount(base, mark), 0)
  const later = [...base, own('m2', '2026-11-13T14:05:00Z'), reply('r2', '2026-11-13T14:06:00Z'), reply('r3', '2026-11-13T14:07:00Z')]
  assert.equal(unreadCount(later, mark), 2)
})

test('unread goes by position, so a reply with an odd clock still counts once it is after the mark', () => {
  const mark = seenMark(base, NOW)
  const skewed = [...base, reply('r2', '2026-11-13T13:00:00Z')]
  assert.equal(unreadCount(skewed, mark), 1)
})

test('marked reply gone from the list: falls back to time', () => {
  const mark = { id: 'gone', t: '2026-11-13T14:01:00Z' }
  const chat = [reply('r2', '2026-11-13T14:00:00Z'), reply('r3', '2026-11-13T14:02:00Z')]
  assert.equal(unreadCount(chat, mark), 1)
})

test('first reply after a mark taken with no replies counts', () => {
  const first = [own('m1', '2026-11-13T14:00:00Z')]
  const mark = seenMark(first, NOW)
  assert.equal(unreadCount([...first, reply('r1', '2026-11-13T14:02:00Z')], mark), 1)
})

test('no mark (project never shown in this browser) counts nothing', () => {
  assert.equal(unreadCount([...base, reply('r2', '2026-11-13T14:06:00Z')], undefined), 0)
})

test('first payload of a project sets a silent baseline, even while not viewing', () => {
  const next = nextSeenMarks({}, 'p1', base, false, NOW)
  assert.deepEqual(next, { p1: { id: 'r1', t: '2026-11-13T14:01:00Z' } })
})

test('not viewing: a new reply leaves the mark alone, so the badge grows', () => {
  const marks: SeenMarks = { p1: seenMark(base, NOW) }
  const chat = [...base, reply('r2', '2026-11-13T14:06:00Z')]
  assert.equal(nextSeenMarks(marks, 'p1', chat, false, NOW), null)
  assert.equal(unreadCount(chat, marks.p1), 1)
})

test('viewing clears: the mark moves to the newest reply', () => {
  const marks: SeenMarks = { p1: seenMark(base, NOW) }
  const chat = [...base, reply('r2', '2026-11-13T14:06:00Z')]
  const next = nextSeenMarks(marks, 'p1', chat, true, NOW)
  assert.ok(next)
  assert.equal(unreadCount(chat, next.p1), 0)
  // nothing new: no rewrite
  assert.equal(nextSeenMarks(next, 'p1', chat, true, NOW), null)
})

test('per project: viewing one project does not clear another', () => {
  const chatA = [...base, reply('r2', '2026-11-13T14:06:00Z')]
  const marks: SeenMarks = { a: seenMark(base, NOW), b: seenMark(base, NOW) }
  const next = nextSeenMarks(marks, 'b', base, true, NOW)
  assert.equal(next, null)
  assert.equal(unreadCount(chatA, marks.a), 1)
  const afterB = nextSeenMarks(marks, 'b', [...base, reply('x', '2026-11-13T14:09:00Z')], true, NOW)
  assert.ok(afterB)
  assert.deepEqual(afterB.a, marks.a)
})

test('no project or no payload yet: nothing changes', () => {
  assert.equal(nextSeenMarks({}, null, base, true, NOW), null)
  assert.equal(nextSeenMarks({}, 'p1', null, true, NOW), null)
})

test('stored marks survive a round trip; junk is dropped, never thrown', () => {
  const marks: SeenMarks = { a: { id: 'r1', t: NOW }, b: { id: '', t: NOW } }
  assert.deepEqual(parseSeenMarks(storeSeenMarks(marks)), marks)
  assert.deepEqual(parseSeenMarks('{'), {})
  assert.deepEqual(parseSeenMarks('[1]'), {})
  assert.deepEqual(parseSeenMarks(null), {})
  assert.deepEqual(parseSeenMarks('{"a":{"id":1,"t":"x"},"b":{"id":"r","t":"y"}}'), { b: { id: 'r', t: 'y' } })
})

test('badge text and screen-reader words', () => {
  assert.equal(unreadBadge(0), '')
  assert.equal(unreadBadge(3), '3')
  assert.equal(unreadBadge(12), '9+')
  assert.equal(unreadLabel(0, 'Sora'), '')
  assert.equal(unreadLabel(1, 'Sora'), '1 balasan baru dari Sora')
  assert.equal(unreadLabel(4, 'Sora'), '4 balasan baru dari Sora')
})
