import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  DEFAULT_VOLUME,
  SOUND_MUTE_KEY,
  SOUND_VOLUME_KEY,
  SoundSettingsStore,
  parseMuted,
  parseVolume,
  type StorageLike,
} from './settings'

function memoryStorage(init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...init }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v
    },
  }
}

function fakeOutput() {
  const calls: string[] = []
  return {
    calls,
    setMuted: (m: boolean) => calls.push(`muted:${m}`),
    setVolume: (v: number) => calls.push(`volume:${v}`),
  }
}

test('muted unless explicitly on', () => {
  assert.equal(parseMuted(null), true)
  assert.equal(parseMuted('off'), true)
  assert.equal(parseMuted('garbage'), true)
  assert.equal(parseMuted('on'), false)
})

test('volume parses, clamps and falls back to the default', () => {
  assert.equal(parseVolume(null), DEFAULT_VOLUME)
  assert.equal(parseVolume(''), DEFAULT_VOLUME)
  assert.equal(parseVolume('abc'), DEFAULT_VOLUME)
  assert.equal(parseVolume('0.25'), 0.25)
  assert.equal(parseVolume('0'), 0)
  assert.equal(parseVolume('7'), 1)
  assert.equal(parseVolume('-1'), 0)
})

test('a fresh page is muted and tells the engine so', () => {
  const out = fakeOutput()
  const store = new SoundSettingsStore(() => memoryStorage(), out)
  assert.deepEqual(store.get(), { muted: true, volume: DEFAULT_VOLUME })
  assert.ok(out.calls.includes('muted:true'))
})

test('the choice survives a reload', () => {
  const storage = memoryStorage()
  const first = new SoundSettingsStore(() => storage)
  first.toggleMuted()
  first.setVolume(0.8)
  assert.equal(storage.data[SOUND_MUTE_KEY], 'on')
  assert.equal(storage.data[SOUND_VOLUME_KEY], '0.8')
  const out = fakeOutput()
  const reloaded = new SoundSettingsStore(() => storage, out)
  assert.deepEqual(reloaded.get(), { muted: false, volume: 0.8 })
  assert.ok(out.calls.includes('muted:false'))
  assert.ok(out.calls.includes('volume:0.8'))
  reloaded.toggleMuted()
  assert.equal(storage.data[SOUND_MUTE_KEY], 'off')
  assert.equal(new SoundSettingsStore(() => storage).get().muted, true)
})

test('mute and volume reach the engine and the listeners', () => {
  const out = fakeOutput()
  const store = new SoundSettingsStore(() => memoryStorage(), out)
  let heard = 0
  const off = store.subscribe(() => heard++)
  out.calls.length = 0
  assert.equal(store.toggleMuted(), false)
  store.setVolume(0.3)
  assert.deepEqual(out.calls, ['muted:false', 'volume:0.3'])
  assert.equal(heard, 2)
  store.setVolume(0.3) // unchanged: no event
  assert.equal(heard, 2)
  off()
  store.toggleMuted()
  assert.equal(heard, 2)
})

test('a storage that throws never breaks the toggle', () => {
  const throwing: StorageLike = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
  }
  const store = new SoundSettingsStore(() => throwing)
  assert.equal(store.get().muted, true)
  assert.equal(store.toggleMuted(), false)
  store.setVolume(0.9)
  assert.deepEqual(store.get(), { muted: false, volume: 0.9 })
  const noStorage = new SoundSettingsStore(() => {
    throw new Error('no window')
  })
  assert.equal(noStorage.get().muted, true)
})
