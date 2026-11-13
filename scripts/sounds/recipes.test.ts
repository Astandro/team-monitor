import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { CUE_PRIORITY } from '../../web/lib/sound/cues'
import { SAMPLE_FILES, SAMPLE_REPORT } from '../../web/lib/sound/samples'
// plain JS module: the build script's recipe list
import { PACKS, RECIPES } from './recipes.mjs'

interface Layer { src: string; at?: number; endAt?: number; rate?: number; from?: number; to?: number }
interface Recipe { cue: string; file: string; dur: number; target: { lufs: number; peak: number }; layers: Layer[] }
const recipes = RECIPES as Recipe[]

test('one recipe per event, writing the file the app maps to that event', () => {
  assert.deepEqual(recipes.map((r) => r.cue).sort(), [...CUE_PRIORITY].sort())
  for (const r of recipes) assert.equal(r.file, SAMPLE_FILES[r.cue as keyof typeof SAMPLE_FILES], r.cue)
})

test('the committed files were built from these recipes (targets and sources match the build report)', () => {
  for (const r of recipes) {
    const info = SAMPLE_REPORT.cues[r.cue as keyof typeof SAMPLE_REPORT.cues]
    assert.deepEqual(info.target, r.target, `${r.cue}: rebuild with scripts/sounds/build.mjs`)
    assert.deepEqual(info.sources, [...new Set(r.layers.map((l) => l.src))], r.cue)
    assert.ok(Math.abs(info.duration - r.dur) < 0.08, `${r.cue}: ${info.duration} s vs ${r.dur} s`)
  }
})

test('sources only come from the licensed packs; levels go from quiet blips to big rare events', () => {
  for (const r of recipes) {
    assert.ok(r.layers.length > 0, r.cue)
    for (const l of r.layers) {
      const [pack, file] = l.src.split('/')
      assert.ok(pack in PACKS, `${r.cue}: ${l.src}`)
      assert.match(file, /^[A-Za-z0-9_]+\.ogg$/)
      assert.ok((l.rate ?? 1) >= 0.25 && (l.rate ?? 1) <= 2, `${r.cue}: rate`)
    }
    assert.ok(r.target.peak <= -1.5 && r.target.peak >= -24, r.cue)
  }
})
