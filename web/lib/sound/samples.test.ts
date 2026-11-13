import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { CUE_PRIORITY, type SoundCue } from './cues'
import { SAMPLE_FILES, SAMPLE_REPORT, sampleUrl, sampleUrls } from './samples'

const SOUNDS_DIR = path.join(__dirname, '..', '..', 'public', 'sounds')
/** The names app/build.js copies and app/src/static.ts serves. */
const SERVABLE = /^[a-z0-9][a-z0-9._-]*\.(ogg|mp3)$/

const cues = [...CUE_PRIORITY]
const info = (c: SoundCue) => SAMPLE_REPORT.cues[c]

test('every event has its own file, with a name the app serves, at the app root', () => {
  assert.deepEqual(Object.keys(SAMPLE_FILES).sort(), [...cues].sort())
  const files = Object.values(SAMPLE_FILES)
  assert.equal(new Set(files).size, files.length)
  for (const c of cues) {
    assert.match(SAMPLE_FILES[c], SERVABLE, c)
    assert.equal(SAMPLE_FILES[c], `sfx-${c}.mp3`)
    assert.equal(sampleUrl(c), `/sfx-${c}.mp3`)
  }
  assert.equal(sampleUrls('/x/').stage_done, '/x/sfx-stage_done.mp3')
})

test('the files on disk are exactly the mapped ones, as the build report describes them, under 1.5 MB in all', () => {
  const onDisk = fs.readdirSync(SOUNDS_DIR).filter((f) => SERVABLE.test(f)).sort()
  assert.deepEqual(onDisk, Object.values(SAMPLE_FILES).sort())
  let total = 0
  for (const c of cues) {
    assert.equal(info(c).file, SAMPLE_FILES[c], c)
    const bytes = fs.statSync(path.join(SOUNDS_DIR, SAMPLE_FILES[c])).size
    assert.equal(bytes, info(c).bytes, `${c}: file differs from the build report (rebuild with scripts/sounds/build.mjs)`)
    total += bytes
  }
  assert.equal(total, SAMPLE_REPORT.totalBytes)
  assert.ok(total < 1_500_000, `${total} bytes`)
})

test('levels from the build report: each file meets its target and never passes its peak cap', () => {
  for (const c of cues) {
    const { lufsMax, truePeak, target } = info(c)
    assert.ok(truePeak <= target.peak, `${c}: peak ${truePeak} over cap ${target.peak}`)
    assert.ok(truePeak <= -1.5, `${c}: peak ${truePeak}`)
    assert.ok(lufsMax <= target.lufs + 0.5, `${c}: ${lufsMax} LUFS over target ${target.lufs}`)
    // the quiet blips are held by their peak cap, the rest reach their loudness within 1.5 dB
    if (truePeak < target.peak - 2.5) assert.ok(lufsMax >= target.lufs - 1.5, `${c}: ${lufsMax} LUFS, target ${target.lufs}`)
  }
})

test('frequent sounds are quiet and short, rare ones big; the decision waiting is louder than all but the two epic ones', () => {
  const frequent: SoundCue[] = ['tool_start', 'tool_complete', 'handoff']
  for (const c of frequent) {
    assert.ok(info(c).lufsMax <= -33, c)
    assert.ok(info(c).truePeak <= -20, c)
    assert.ok(info(c).duration <= 0.5, c)
  }
  const epic: SoundCue[] = ['session_start', 'stage_done']
  for (const c of epic) {
    assert.ok(info(c).duration >= 3 && info(c).duration <= 5, c)
    for (const o of cues.filter((x) => !epic.includes(x))) assert.ok(info(c).lufsMax > info(o).lufsMax, `${c} vs ${o}`)
  }
  for (const o of cues.filter((x) => x !== 'decision_open' && !epic.includes(x))) {
    assert.ok(info('decision_open').lufsMax > info(o).lufsMax + 2, o)
  }
  for (const c of cues.filter((x) => !frequent.includes(x))) {
    for (const f of frequent) assert.ok(info(c).lufsMax > info(f).lufsMax + 5, `${c} vs ${f}`)
  }
  for (const c of cues) assert.ok(info(c).duration > 0.1 && info(c).duration <= 5, c)
})

test('every source sample is from a pack in LICENSES.md, named there, and fingerprinted in the report', () => {
  const licences = fs.readFileSync(path.join(SOUNDS_DIR, 'LICENSES.md'), 'utf8')
  const used = new Set<string>()
  for (const c of cues) for (const s of info(c).sources) used.add(s)
  assert.deepEqual([...used].sort(), Object.keys(SAMPLE_REPORT.sources).sort())
  for (const s of used) {
    const [pack, file] = s.split('/')
    assert.ok(pack === 'scifi' || pack === 'interface', s)
    assert.ok(licences.includes(file), `${file} missing from LICENSES.md`)
    assert.match(SAMPLE_REPORT.sources[s], /^[0-9a-f]{64}$/)
  }
  assert.match(licences, /CC0/)
})
