import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { CUE_PRIORITY } from '../../web/lib/sound/cues'
import { AMBIENCE_KINDS } from '../../web/lib/sound/ambience'
import { LOOP_FILES, SAMPLE_FILES, SAMPLE_REPORT } from '../../web/lib/sound/samples'
// plain JS module: the build script's recipe list
import { LOOPS, PACKS, RECIPES } from './recipes.mjs'

interface Layer { src: string; at?: number; rate?: number; from?: number; to?: number; gain?: number }
interface Recipe { cue?: string; loop?: string; file: string; target: { lufs: number; peak: number }; layers: Layer[]; period?: number; crossfade?: number }
const recipes = RECIPES as Recipe[]
const loops = LOOPS as Recipe[]
const SOURCES = path.join(__dirname, 'sources')

test('one recipe per event and one per background loop, writing the file the app maps to it', () => {
  assert.deepEqual(recipes.map((r) => r.cue).sort(), [...CUE_PRIORITY].sort())
  for (const r of recipes) assert.equal(r.file, SAMPLE_FILES[r.cue as keyof typeof SAMPLE_FILES], r.cue)
  assert.deepEqual(loops.map((r) => r.loop).sort(), [...AMBIENCE_KINDS].sort())
  for (const r of loops) assert.equal(r.file, LOOP_FILES[r.loop as keyof typeof LOOP_FILES], r.loop)
})

test('loudness targets of the spec: alerts -14, milestones -18, frequent -20; loops owner -20, waiting -21, disintegrating -26, thinking -28', () => {
  const want: Record<string, number> = {
    decision_open: -14, task_blocked: -14, tool_error: -14,
    tool_start: -20, tool_complete: -20, handoff: -20,
  }
  for (const r of recipes) assert.equal(r.target.lufs, want[r.cue!] ?? -18, r.cue)
  assert.deepEqual(Object.fromEntries(loops.map((r) => [r.loop, r.target.lufs])), { owner: -20, waiting: -21, thinking: -28, disintegrating: -26 })
  for (const r of [...recipes, ...loops]) assert.ok(r.target.peak <= -1.5, r.file)
})

test('loop periods: owner 2.2 s, waiting 1.5 s, thinking about 6 s of material with a crossfade, disintegrating 4.9 s', () => {
  const by = Object.fromEntries(loops.map((r) => [r.loop, r]))
  assert.equal(by.owner.period, 2.2)
  assert.equal(by.waiting.period, 1.5)
  assert.equal(by.disintegrating.period, 4.9)
  assert.equal(by.thinking.period! + by.thinking.crossfade!, 6)
  assert.ok(by.thinking.crossfade! > 0)
})

test('the committed files were built from these recipes (targets, sources and loop periods match the build report)', () => {
  for (const r of recipes) {
    const info = SAMPLE_REPORT.cues[r.cue as keyof typeof SAMPLE_REPORT.cues]
    assert.deepEqual(info.target, r.target, `${r.cue}: rebuild with scripts/sounds/build.mjs`)
    assert.deepEqual(info.sources, [...new Set(r.layers.map((l) => l.src))], r.cue)
  }
  for (const r of loops) {
    const info = SAMPLE_REPORT.loops[r.loop as keyof typeof SAMPLE_REPORT.loops]
    assert.deepEqual(info.target, r.target, r.loop)
    assert.equal(info.period, r.period, r.loop)
    assert.ok(Math.abs(info.duration - 2 * r.period!) < 0.01, `${r.loop}: the file holds two periods`)
  }
})

test('sources: only the licensed pack, every used file committed, nothing unused committed', () => {
  const used = new Set<string>()
  for (const r of [...recipes, ...loops]) {
    assert.ok(r.layers.length > 0, r.file)
    for (const l of r.layers) {
      const [pack, file] = l.src.split('/')
      assert.ok(pack in PACKS, `${r.file}: ${l.src}`)
      assert.match(file, /^[A-Za-z0-9_-]+\.mp3$/)
      assert.ok((l.rate ?? 1) >= 0.5 && (l.rate ?? 1) <= 2, `${r.file}: rate`)
      used.add(l.src)
    }
  }
  for (const pack of Object.keys(PACKS)) {
    const files = fs.readdirSync(path.join(SOURCES, pack)).filter((f) => f.endsWith('.mp3')).map((f) => `${pack}/${f}`)
    assert.deepEqual(files.sort(), [...used].filter((s) => s.startsWith(`${pack}/`)).sort())
    const licence = fs.readFileSync(path.join(SOURCES, pack, (PACKS as Record<string, { licenceFile: string }>)[pack].licenceFile), 'utf8')
    assert.match(licence, /CC BY 4\.0/)
  }
  assert.deepEqual(Object.keys(SAMPLE_REPORT.sources).sort(), [...used].sort())
})
