import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  DEFAULT_VOLUME,
  SOUND_MUTE_KEY,
  SOUND_VOLUME_KEY,
  SOUND_VOLUME_SCALE_KEY,
  SoundSettingsStore,
  VOLUME_SCALE_SQUARED,
  migrateStoredVolume,
  parseMuted,
  parseVolume,
  volumeGain,
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

test('a fresh profile starts at volume 0.7 and nothing is written', () => {
  assert.equal(DEFAULT_VOLUME, 0.7)
  const storage = memoryStorage()
  const fresh = new SoundSettingsStore(() => storage)
  assert.equal(fresh.get().volume, 0.7)
  assert.deepEqual(storage.data, {}, 'no value and no marker for a fresh profile')
  assert.deepEqual(migrateStoredVolume(null, null), { volume: DEFAULT_VOLUME, migrate: false })
  assert.deepEqual(migrateStoredVolume('abc', null), { volume: DEFAULT_VOLUME, migrate: false })
})

test('F9: a volume stored by 0.9.6 or earlier is migrated once to sqrt(old), so the gain stays what the user had', () => {
  const storage = memoryStorage({ [SOUND_VOLUME_KEY]: '0.5' })
  const out = fakeOutput()
  const store = new SoundSettingsStore(() => storage, out)
  const v = store.get().volume
  assert.ok(Math.abs(v - Math.SQRT1_2) < 1e-12, `slider ${v}`)
  assert.ok(Math.abs(volumeGain(v) - 0.5) < 1e-12, 'same gain as 0.9.6 played for 0.5')
  assert.ok(out.calls.includes(`volume:${v}`))
  assert.equal(storage.data[SOUND_VOLUME_SCALE_KEY], VOLUME_SCALE_SQUARED, 'marked')
  assert.equal(storage.data[SOUND_VOLUME_KEY], String(v))
  assert.equal(new SoundSettingsStore(() => memoryStorage({ [SOUND_VOLUME_KEY]: '1' })).get().volume, 1)
  assert.equal(new SoundSettingsStore(() => memoryStorage({ [SOUND_VOLUME_KEY]: '0' })).get().volume, 0)
  assert.equal(migrateStoredVolume('0.25', null).volume, 0.5)
  assert.equal(migrateStoredVolume('0.25', null).migrate, true)
})

test('F9: the second load leaves the migrated volume unchanged', () => {
  const storage = memoryStorage({ [SOUND_VOLUME_KEY]: '0.25' })
  assert.equal(new SoundSettingsStore(() => storage).get().volume, 0.5)
  const snapshot = { ...storage.data }
  for (let i = 0; i < 3; i++) assert.equal(new SoundSettingsStore(() => storage).get().volume, 0.5)
  assert.deepEqual(storage.data, snapshot, 'nothing rewritten')
})

test('F9: a volume already stored with the marker (0.9.7) is left alone', () => {
  const storage = memoryStorage({ [SOUND_VOLUME_KEY]: '0.5', [SOUND_VOLUME_SCALE_KEY]: VOLUME_SCALE_SQUARED })
  assert.equal(new SoundSettingsStore(() => storage).get().volume, 0.5)
  assert.equal(storage.data[SOUND_VOLUME_KEY], '0.5', 'not rewritten')
  assert.deepEqual(migrateStoredVolume('0.5', VOLUME_SCALE_SQUARED), { volume: 0.5, migrate: false })
  // a volume the user sets now carries the marker, so it is never migrated later
  const fresh = memoryStorage()
  new SoundSettingsStore(() => fresh).setVolume(0.4)
  assert.equal(fresh.data[SOUND_VOLUME_SCALE_KEY], VOLUME_SCALE_SQUARED)
  assert.equal(new SoundSettingsStore(() => fresh).get().volume, 0.4)
})

test('slider gain is the value squared: 0.5 gives 0.25, 0.7 about 0.49, ends at 0 and 1', () => {
  assert.equal(volumeGain(0.5), 0.25)
  assert.ok(Math.abs(volumeGain(0.7) - 0.49) < 1e-12)
  assert.equal(volumeGain(0), 0)
  assert.equal(volumeGain(1), 1)
  assert.equal(volumeGain(2), 1, 'clamped')
  assert.equal(volumeGain(Number.NaN), DEFAULT_VOLUME * DEFAULT_VOLUME)
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
