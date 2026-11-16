import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// plain JS modules of the sound build
import {
  kWeight, levelAndClip, levelProblems, loopPeriod, mix, repeat, segment, SR, wholeLoudness,
} from './dsp.mjs'

const BUILD = path.join(__dirname, 'build.mjs')
const REPORT = path.join(__dirname, '..', '..', 'web', 'lib', 'sound', 'sample-report.json')

const sine = (freq: number, seconds: number, amp = 1) =>
  Float64Array.from({ length: Math.round(seconds * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR))

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sounds-'))
}

function removeTmp(dir: string): void {
  // only ever the folder mkdtemp made for this test
  if (dir && dir.startsWith(path.join(os.tmpdir(), 'tm-sounds-'))) fs.rmSync(dir, { recursive: true, force: true })
}

test('segment: trim, pitch, peak-normalise, fades and gain as the reference mixer', () => {
  const src = Float32Array.from({ length: SR }, (_, i) => (i % 100) / 200) // ramp, peak 0.495
  const x = segment(src, { from: 0.25, to: 0.75, fadeIn: 0.01, fadeOut: 0.1, gain: 0.5 })
  assert.equal(x.length, SR / 2)
  assert.equal(x[0], 0, 'fade in starts at silence')
  assert.equal(x[x.length - 1], 0, 'fade out ends at silence')
  const peak = Math.max(...x.map(Math.abs))
  assert.ok(peak <= 0.5 + 1e-9 && peak > 0.49, `normalised to 1, then gain 0.5: ${peak}`)
  // rate 2: half as long (numpy arange(0, len - 1, 2))
  assert.equal(segment(src, { from: 0, to: 0.5, rate: 2 }).length, Math.ceil((SR / 2 - 1) / 2))
  assert.equal(segment(src, { from: 0, to: 0.5, rate: 0.75 }).length, Math.ceil((SR / 2 - 1) / 0.75))
})

test('mix places layers at their times and sums them', () => {
  const y = mix([{ at: 0, x: Float64Array.of(1, 1) }, { at: 1 / SR, x: Float64Array.of(2, 2) }])
  assert.deepEqual([...y], [1, 3, 2])
})

test('loopPeriod without crossfade folds the tail onto the start: the same as endless repetition', () => {
  const x = Float64Array.from({ length: 10 }, (_, i) => i + 1)
  // period 4 frames: 1..4, 5..8 and 9..10 summed
  const p = 4 / SR
  assert.deepEqual([...loopPeriod(x, p)], [1 + 5 + 9, 2 + 6 + 10, 3 + 7, 4 + 8])
  // the seam of the loop is continuous: last sample of one turn -> first of the next follows the material
  const tone = sine(50, 1.3)
  const loop = loopPeriod(tone, 1)
  const steady = repeat(loop, 3)
  // one period in, repetition and the folded loop agree everywhere
  const reps = new Float64Array(3 * SR)
  for (let k = 0; k < 3; k++) for (let i = 0; i < tone.length && k * SR + i < reps.length; i++) reps[k * SR + i] += tone[i]
  for (let i = SR; i < 3 * SR; i++) assert.ok(Math.abs(reps[i] - steady[i]) < 1e-9)
})

test('loopPeriod with crossfade keeps the power steady across the seam (equal-power pair)', () => {
  // continuous, uncorrelated material (seeded noise, like an ambience), folded with a 0.5 s crossfade into a 1 s loop
  let seed = 12345
  const x = Float64Array.from({ length: Math.round(1.5 * SR) }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 1073741824 - 1
  })
  const y = loopPeriod(x, 1, 0.5)
  assert.equal(y.length, SR)
  const rms = (a: Float64Array, from: number, to: number) => Math.sqrt(a.subarray(from, to).reduce((s, v) => s + v * v, 0) / (to - from))
  const seam = rms(y, 0, SR / 2)
  const body = rms(y, SR / 2, SR)
  assert.ok(Math.abs(20 * Math.log10(seam / body)) < 1, `seam ${seam} vs body ${body}`)
  // no jump where the loop wraps: the turn ends on x[p - 1] and starts again on (almost exactly) x[p], its successor
  assert.equal(y[SR - 1], x[SR - 1])
  assert.ok(Math.abs(y[0] - x[SR]) < 0.01)
  assert.throws(() => loopPeriod(x, 1.2, 0.5), /material/)
})

test('levelAndClip: gain, then a tanh soft clip holds the ceiling', () => {
  const x = Float64Array.of(0.1, -0.5, 1)
  const y = levelAndClip(x, 2, -6)
  const cap = 10 ** (-6 / 20)
  for (const v of y) assert.ok(Math.abs(v) <= cap)
  assert.deepEqual([...levelAndClip(x, 0.5, 0)], [0.05, -0.25, 0.5], 'under the ceiling: plain gain')
})

test('K-weighted whole-length loudness: a full-scale 997 Hz sine reads -3.01 LUFS', () => {
  const l = wholeLoudness(sine(997, 2))
  assert.ok(Math.abs(l - -3.01) < 0.05, `${l}`)
  // a 200 ms tone at the same level, spread over its own length, reads the same
  assert.ok(Math.abs(wholeLoudness(sine(997, 0.2)) - -3.01) < 0.3)
  // measuring over a longer length (silent padding) lowers it by the length ratio
  const short = sine(997, 0.2)
  assert.ok(Math.abs(wholeLoudness(short, short.length * 2) - (wholeLoudness(short) - 3.01)) < 0.01)
  assert.equal(kWeight(Float64Array.of(0, 0)).length, 2)
})

test('levelProblems: a file more than 1.5 LU off its target, or over its peak cap or -1 dBTP, is a problem', () => {
  const target = { lufs: -18, peak: -3 }
  assert.deepEqual(levelProblems({ a: { lufsMax: -19.5, truePeak: -4, target }, b: { lufsMax: -16.5, truePeak: -3, target } }), [])
  assert.equal(levelProblems({ a: { lufsMax: -19.6, truePeak: -4, target } }).length, 1)
  assert.equal(levelProblems({ a: { lufsMax: -16.4, truePeak: -4, target } }).length, 1)
  assert.equal(levelProblems({ a: { lufsMax: -18, truePeak: -2.9, target } }).length, 1)
  assert.equal(levelProblems({ a: { lufsMax: -14, truePeak: -0.9, target: { lufs: -14, peak: 0 } } }).length, 1)
  assert.equal(levelProblems({ a: { lufsMax: NaN, truePeak: -4, target } }).length, 1)
})

test('build --check: the committed report passes; a report with one file forced off target exits non-zero', () => {
  const ok = spawnSync(process.execPath, [BUILD, '--check', REPORT], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  const dir = tmpDir()
  try {
    const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'))
    report.cues.task_done.lufsMax = report.cues.task_done.target.lufs + 1.6
    const file = path.join(dir, 'report.json')
    fs.writeFileSync(file, JSON.stringify(report))
    const bad = spawnSync(process.execPath, [BUILD, '--check', file], { encoding: 'utf8' })
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /task_done: .* off its target -18/)
    report.cues.task_done.lufsMax = -18
    report.loops.owner.lufsMax = -22
    fs.writeFileSync(file, JSON.stringify(report))
    const badLoop = spawnSync(process.execPath, [BUILD, '--check', file], { encoding: 'utf8' })
    assert.equal(badLoop.status, 1)
    assert.match(badLoop.stderr, /loop owner/)
  } finally {
    removeTmp(dir)
  }
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

test('a real build of one cue forced 3 dB off target exits non-zero; the same build on target exits 0', { skip: !hasFfmpeg && 'ffmpeg not on PATH' }, () => {
  const dir = tmpDir()
  try {
    const args = (offset: string) => [BUILD, '--only', 'tool_complete', '--out', dir, '--report', path.join(dir, 'r.json'), '--offset', `tool_complete=${offset}`]
    const off = spawnSync(process.execPath, args('3'), { encoding: 'utf8' })
    assert.equal(off.status, 1, off.stdout + off.stderr)
    assert.match(off.stderr, /tool_complete/)
    const on = spawnSync(process.execPath, args('0'), { encoding: 'utf8' })
    assert.equal(on.status, 0, on.stdout + on.stderr)
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'))
    assert.equal(r.cues.tool_complete.measuredOn, 'whole', 'tool_complete is under 400 ms')
    assert.ok(fs.existsSync(path.join(dir, 'sfx-tool_complete.mp3')))
  } finally {
    removeTmp(dir)
  }
})
