import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AvatarBitmapCache, avatarKey, avatarSide, type AvatarRequest } from './avatar-bitmap'
import { botAvatarSvg } from './bot-avatar'

function fakeCache(max?: number) {
  const calls: { svg: string; req: AvatarRequest }[] = []
  const cache = new AvatarBitmapCache((svg, req) => {
    calls.push({ svg, req })
    return { id: calls.length, svg }
  }, max)
  return { cache, calls }
}

test('one bitmap per name and theme, reused on every later frame', () => {
  const { cache, calls } = fakeCache()
  const a = cache.get({ name: 'Orion', coordinator: false, theme: 'dark' })
  for (let i = 0; i < 100; i++) {
    assert.equal(cache.get({ name: 'Orion', coordinator: false, theme: 'dark' }), a, 'the same object every frame')
  }
  assert.equal(calls.length, 1, 'rendered once')
  assert.equal(cache.renderCount, 1)
  assert.equal(cache.size, 1)
})

test('the other theme gets its own bitmap, also made once', () => {
  const { cache, calls } = fakeCache()
  const dark = cache.get({ name: 'Orion', coordinator: false, theme: 'dark' })
  const light = cache.get({ name: 'Orion', coordinator: false, theme: 'light' })
  assert.notEqual(dark, light)
  cache.get({ name: 'Orion', coordinator: false, theme: 'light' })
  cache.get({ name: 'Orion', coordinator: false, theme: 'dark' })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c.req.theme), ['dark', 'light'])
})

test('different names and the coordinator style are separate bitmaps', () => {
  const { cache, calls } = fakeCache()
  const orion = cache.get({ name: 'Orion', coordinator: false, theme: 'dark' })
  const mei = cache.get({ name: 'Mei', coordinator: false, theme: 'dark' })
  const sora = cache.get({ name: 'Sora', coordinator: true, theme: 'dark' })
  const soraMember = cache.get({ name: 'Sora', coordinator: false, theme: 'dark' })
  assert.equal(new Set([orion, mei, sora, soraMember]).size, 4)
  assert.equal(calls.length, 4)
})

test('the bitmap is the team list avatar: same markup as botAvatarSvg for the name and role', () => {
  const { cache, calls } = fakeCache()
  cache.get({ name: 'Felix', coordinator: false, theme: 'light' })
  cache.get({ name: 'Sora', coordinator: true, theme: 'light' })
  assert.equal(calls[0].svg, botAvatarSvg('Felix'))
  assert.equal(calls[1].svg, botAvatarSvg('Sora', { coordinator: true }))
  assert.notEqual(calls[0].svg, calls[1].svg)
})

test('names match like the avatar hash: case and outer spaces do not make a second bitmap', () => {
  const { cache, calls } = fakeCache()
  const a = cache.get({ name: 'Orion', coordinator: false, theme: 'dark' })
  assert.equal(cache.get({ name: ' orion ', coordinator: false, theme: 'dark' }), a)
  assert.equal(calls.length, 1)
  assert.equal(avatarKey({ name: 'ORION', coordinator: false, theme: 'dark' }), avatarKey({ name: 'orion', coordinator: false, theme: 'dark' }))
  assert.notEqual(avatarKey({ name: 'orion', coordinator: true, theme: 'dark' }), avatarKey({ name: 'orion', coordinator: false, theme: 'dark' }))
  assert.notEqual(avatarKey({ name: 'orion', coordinator: false, theme: 'light' }), avatarKey({ name: 'orion', coordinator: false, theme: 'dark' }))
})

test('bounded: past the cap the least recently used bitmap goes, the ones in use stay', () => {
  const { cache, calls } = fakeCache(3)
  const a = cache.get({ name: 'A', coordinator: false, theme: 'dark' })
  cache.get({ name: 'B', coordinator: false, theme: 'dark' })
  cache.get({ name: 'C', coordinator: false, theme: 'dark' })
  assert.equal(cache.get({ name: 'A', coordinator: false, theme: 'dark' }), a, 'A used again, so B is now the oldest')
  cache.get({ name: 'D', coordinator: false, theme: 'dark' })
  assert.equal(cache.size, 3)
  assert.equal(cache.get({ name: 'A', coordinator: false, theme: 'dark' }), a, 'A kept')
  assert.equal(calls.length, 4)
  cache.get({ name: 'B', coordinator: false, theme: 'dark' })
  assert.equal(calls.length, 5, 'B was dropped and is rendered again')
})

test('the tile fits inside the hexagon: its rounded corners stay within the inner circle', () => {
  for (const r of [20, 28]) {
    const s = avatarSide(r)
    const half = s / 2
    const corner = s * 0.28
    const farthest = Math.SQRT2 * (half - corner) + corner
    assert.ok(farthest <= r * Math.cos(Math.PI / 6), `r=${r}: ${farthest.toFixed(2)} inside ${(r * Math.cos(Math.PI / 6)).toFixed(2)}`)
    assert.ok(s >= r * 1.2, 'large enough to read')
  }
})
