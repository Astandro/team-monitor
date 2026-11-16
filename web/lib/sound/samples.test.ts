import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { AMBIENCE_KINDS, type AmbienceKind } from './ambience'
import { CUE_PRIORITY, type SoundCue } from './cues'
import { LOOP_FILES, loopKey, loopWindow, SAMPLE_FILES, SAMPLE_REPORT, sampleUrl, sampleUrls, SOUND_CREDIT } from './samples'

const SOUNDS_DIR = path.join(__dirname, '..', '..', 'public', 'sounds')
/** The names app/build.js copies and app/src/static.ts serves. */
const SERVABLE = /^[a-z0-9][a-z0-9._-]*\.(ogg|mp3)$/

const cues = [...CUE_PRIORITY]
const info = (c: SoundCue) => SAMPLE_REPORT.cues[c]
const loop = (k: AmbienceKind) => SAMPLE_REPORT.loops[k]

/** Spec 0.9.7 targets (LUFS). */
const TARGET: Record<SoundCue, number> = {
  decision_open: -14, task_blocked: -14, tool_error: -14,
  tool_start: -20, tool_complete: -20, handoff: -20,
  session_start: -18, stage_done: -18, task_start: -18, task_review: -18, task_done: -18,
  decision_answered: -18, agent_spawn: -18, agent_complete: -18, agent_offboarded: -18,
}
const LOOP_TARGET: Record<AmbienceKind, number> = { owner: -20, waiting: -21, disintegrating: -26, thinking: -28 }

test('every event and every loop has its own file, with a name the app serves, at the app root', () => {
  assert.deepEqual(Object.keys(SAMPLE_FILES).sort(), [...cues].sort())
  assert.deepEqual(Object.keys(LOOP_FILES).sort(), [...AMBIENCE_KINDS].sort())
  const files = [...Object.values(SAMPLE_FILES), ...Object.values(LOOP_FILES)]
  assert.equal(new Set(files).size, files.length)
  for (const c of cues) {
    assert.match(SAMPLE_FILES[c], SERVABLE, c)
    assert.equal(SAMPLE_FILES[c], `sfx-${c}.mp3`)
    assert.equal(sampleUrl(c), `/sfx-${c}.mp3`)
  }
  for (const k of AMBIENCE_KINDS) assert.match(LOOP_FILES[k], SERVABLE, k)
  const urls = sampleUrls('/x/')
  assert.equal(urls.stage_done, '/x/sfx-stage_done.mp3')
  assert.equal(urls[loopKey('owner')], '/x/loop-owner.mp3')
  assert.equal(Object.keys(urls).length, 19, '15 event sounds and 4 loops')
})

test('the files on disk are exactly the mapped ones, as the build report describes them, under 1.5 MB in all', () => {
  const onDisk = fs.readdirSync(SOUNDS_DIR).filter((f) => SERVABLE.test(f)).sort()
  assert.deepEqual(onDisk, [...Object.values(SAMPLE_FILES), ...Object.values(LOOP_FILES)].sort())
  let total = 0
  const entries = [...cues.map((c) => [c, info(c), SAMPLE_FILES[c]] as const), ...AMBIENCE_KINDS.map((k) => [k, loop(k), LOOP_FILES[k]] as const)]
  for (const [name, entry, file] of entries) {
    assert.equal(entry.file, file, name)
    const bytes = fs.statSync(path.join(SOUNDS_DIR, file)).size
    assert.equal(bytes, entry.bytes, `${name}: file differs from the build report (rebuild with scripts/sounds/build.mjs)`)
    total += bytes
  }
  assert.equal(total, SAMPLE_REPORT.totalBytes)
  assert.ok(total < 1_500_000, `${total} bytes`)
})

test('levels from the build report: every file within 1.5 LU of the spec target, true peak at most -1 dBTP and under its cap', () => {
  for (const c of cues) {
    const { lufsMax, truePeak, target } = info(c)
    assert.equal(target.lufs, TARGET[c], c)
    assert.ok(Math.abs(lufsMax - target.lufs) <= 1.5, `${c}: ${lufsMax} LUFS, target ${target.lufs}`)
    assert.ok(truePeak <= -1 && truePeak <= target.peak, `${c}: peak ${truePeak}`)
  }
  for (const k of AMBIENCE_KINDS) {
    const { lufsMax, truePeak, target } = loop(k)
    assert.equal(target.lufs, LOOP_TARGET[k], k)
    assert.ok(Math.abs(lufsMax - target.lufs) <= 1.5, `loop ${k}: ${lufsMax} LUFS, target ${target.lufs}`)
    assert.ok(truePeak <= -1 && truePeak <= target.peak, `loop ${k}: peak ${truePeak}`)
  }
})

test('cues shorter than the 400 ms window are measured on their whole length, the rest on the loudest window', () => {
  for (const c of cues) {
    const want = info(c).duration < 0.4 ? 'whole' : 'momentary'
    assert.equal(info(c).measuredOn, want, `${c} (${info(c).duration} s)`)
  }
  assert.equal(info('tool_complete').measuredOn, 'whole')
  for (const k of AMBIENCE_KINDS) assert.equal(loop(k).measuredOn, 'momentary')
})

test('loops: each file holds two periods; the app loops exactly one period, clear of the file edges', () => {
  const periods: Record<AmbienceKind, number> = { owner: 2.2, waiting: 1.5, thinking: 5, disintegrating: 4.9 }
  for (const k of AMBIENCE_KINDS) {
    assert.equal(loop(k).period, periods[k], k)
    assert.ok(Math.abs(loop(k).duration - 2 * periods[k]) < 0.01, k)
    const w = loopWindow(k)
    assert.ok(Math.abs(w.end - w.start - periods[k]) < 1e-9, `${k}: one period`)
    assert.ok(w.start >= 0.5 && w.end <= loop(k).duration - 0.5, `${k}: away from encoder delay and padding`)
  }
})

test('credits: pack, author, CC BY 4.0 and "modified", in LICENSES.md and for the settings panel', () => {
  const licences = fs.readFileSync(path.join(SOUNDS_DIR, 'LICENSES.md'), 'utf8')
  for (const s of [SOUND_CREDIT.pack, SOUND_CREDIT.author, SOUND_CREDIT.licence, SOUND_CREDIT.licenceUrl, SOUND_CREDIT.sourceUrl, 'modified']) {
    assert.ok(licences.includes(s), `LICENSES.md names ${s}`)
  }
  assert.equal(SOUND_CREDIT.licence, 'CC BY 4.0')
  assert.equal(SOUND_CREDIT.modified, 'dimodifikasi')
  const control = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'agent-visualizer', 'sound-control.tsx'), 'utf8')
  for (const field of ['pack', 'author', 'licence', 'licenceUrl', 'sourceUrl', 'modified']) {
    assert.ok(control.includes(`SOUND_CREDIT.${field}`), `the settings panel shows ${field}`)
  }
})

test('every source sample is named in LICENSES.md and fingerprinted in the report', () => {
  const licences = fs.readFileSync(path.join(SOUNDS_DIR, 'LICENSES.md'), 'utf8')
  const used = new Set<string>()
  for (const c of cues) for (const s of info(c).sources) used.add(s)
  for (const k of AMBIENCE_KINDS) for (const s of loop(k).sources) used.add(s)
  assert.deepEqual([...used].sort(), Object.keys(SAMPLE_REPORT.sources).sort())
  for (const s of used) {
    const [pack, file] = s.split('/')
    assert.equal(pack, 'gregor-quendel', s)
    assert.ok(licences.includes(file), `${file} missing from LICENSES.md`)
    assert.match(SAMPLE_REPORT.sources[s], /^[0-9a-f]{64}$/)
  }
})
