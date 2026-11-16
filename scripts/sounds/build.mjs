#!/usr/bin/env node
// Builds sound set v4 ("mecha"): web/public/sounds/sfx-<cue>.mp3 (15 event sounds) and loop-<state>.mp3 (4 background
// loops) from the source files under scripts/sounds/sources/, following recipes.mjs, and writes the build report
// web/lib/sound/sample-report.json (length, loudness, true peak, size per file) that the app and its tests read.
//
//   node scripts/sounds/build.mjs                       build everything (needs ffmpeg with libmp3lame on PATH)
//   node scripts/sounds/build.mjs --check [report]      only check a report's levels (no ffmpeg)
//
// Options for trying things without touching the committed files:
//   --out <folder>  --report <file>   write the MP3s / the report elsewhere
//   --only <name,name>                build only these cues or loops
//   --offset <name>=<dB>              turn one finished sound up or down after levelling (to see the check fail)
//
// Mixing is done here in JS (dsp.mjs, a port of the reference mixer); ffmpeg decodes the sources, encodes the MP3s
// and measures them. Level: each sound is mixed, then its overall gain is calibrated until its loudness (EBU R128
// momentary maximum, ffmpeg ebur128; the whole length for sounds under 400 ms) meets the target, with a tanh soft clip
// holding the peaks 1 dB under the cap. The finished MP3 is measured again; the build exits non-zero when any file
// is more than 1.5 LU off its target or over its true-peak cap.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dbToGain, levelAndClip, levelProblems, loopPeriod, mix, MOMENTARY_WINDOW_S, repeat, segment, SR, wholeLoudness,
} from './dsp.mjs'
import { BITRATE, LOOPS, PACKS, RECIPES, SAMPLE_RATE } from './recipes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SOURCES = path.join(HERE, 'sources')
const OUT_DIR = path.join(ROOT, 'web', 'public', 'sounds')
const REPORT = path.join(ROOT, 'web', 'lib', 'sound', 'sample-report.json')

/** Pad sounds with silence before measuring, so the last 400 ms window sees their end. */
const MEASURE_PAD = 0.5
/** The soft clip holds peaks this far under the true-peak cap (MP3 encoding adds a little peak). */
const CLIP_MARGIN_DB = 1
/** Levelling stops once the measured loudness is this close to the target (LU), or after MAX_PASSES. */
const LEVEL_EPS = 0.1
const MAX_PASSES = 8

function parseArgs(argv) {
  const args = { out: OUT_DIR, report: REPORT, only: null, offsets: {}, check: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    if (a === '--check') {
      args.check = v && !v.startsWith('--') ? path.resolve(v) : REPORT
      if (v && !v.startsWith('--')) i++
    } else if (a === '--out' && v) {
      args.out = path.resolve(v)
      i++
    } else if (a === '--report' && v) {
      args.report = path.resolve(v)
      i++
    } else if (a === '--only' && v) {
      args.only = new Set(v.split(','))
      i++
    } else if (a === '--offset' && v) {
      const eq = v.indexOf('=')
      const db = Number(v.slice(eq + 1))
      if (eq < 1 || !Number.isFinite(db)) throw new Error(`--offset wants name=dB, got ${v}`)
      args.offsets[v.slice(0, eq)] = db
      i++
    } else {
      throw new Error(`unknown argument ${a}`)
    }
  }
  return args
}

function run(cmd, argv, input) {
  const r = spawnSync(cmd, argv, { input, maxBuffer: 512 * 1024 * 1024 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}):\n${String(r.stderr || '').slice(-3000)}`)
  return r
}

const ffmpeg = (argv, input) => run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...argv], input)

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** Raw 32-bit float PCM of a mono signal, as ffmpeg's f32le. */
function pcm(x) {
  const f = Float32Array.from(x)
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength)
}

const PCM_IN = ['-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0']

/** Any audio file decoded to mono float at SR (stereo sources are averaged, like ffmpeg -ac 1). */
function decode(file) {
  const out = ffmpeg(['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1']).stdout
  const copy = Buffer.from(out)
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
}

/** Check every pack's licence file names its licence before any of its audio is touched. */
function checkLicences() {
  for (const [name, pack] of Object.entries(PACKS)) {
    const file = path.join(SOURCES, name, pack.licenceFile)
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes(pack.licence) || !text.includes(pack.licenceUrl)) {
      throw new Error(`${file} does not state ${pack.licence}: refusing to use pack "${name}"`)
    }
  }
}

function sourcePath(src) {
  const parts = src.split('/')
  if (parts.length !== 2 || !PACKS[parts[0]] || !/^[A-Za-z0-9_.-]+\.(mp3|wav|ogg)$/.test(parts[1])) throw new Error(`bad source ${src}`)
  return path.join(SOURCES, parts[0], parts[1])
}

const decoded = new Map()
function source(src) {
  if (!decoded.has(src)) decoded.set(src, decode(sourcePath(src)))
  return decoded.get(src)
}

/** The recipe mixed at unity overall gain (one loop period for a loop). */
function render(recipe) {
  const parts = recipe.layers.map(({ src, at = 0, ...opts }) => ({ at, x: segment(source(src), opts) }))
  const x = mix(parts)
  return recipe.loop ? loopPeriod(x, recipe.period, recipe.crossfade) : x
}

/** EBU R128 momentary maximum (LUFS) and true peak (dBTP), from ffmpeg's ebur128, of a file or of PCM. */
function measureEbu(input) {
  const src = typeof input === 'string' ? ['-i', input] : PCM_IN
  const r = ffmpeg(['-nostats', '-v', 'verbose', ...src, '-af', `apad=pad_dur=${MEASURE_PAD},ebur128=peak=true:framelog=verbose`, '-f', 'null', '-'],
    typeof input === 'string' ? undefined : pcm(input))
  const err = String(r.stderr)
  let lufsMax = -Infinity
  for (const m of err.matchAll(/ M:\s*(-?[0-9.]+|-inf)/g)) {
    const v = Number(m[1])
    if (Number.isFinite(v) && v > lufsMax) lufsMax = v
  }
  const tp = err.match(/True peak:\s*\n\s*Peak:\s*(-?[0-9.]+|-inf) dBFS/)
  const truePeak = tp ? Number(tp[1]) : NaN
  if (!Number.isFinite(lufsMax) || !Number.isFinite(truePeak)) throw new Error('could not measure')
  return { lufsMax, truePeak }
}

/** Loudness the way the targets mean it: whole length under 400 ms, else the loudest momentary window. */
function loudness(y, frames) {
  return frames < MOMENTARY_WINDOW_S * SR ? wholeLoudness(y, frames) : measureEbu(y).lufsMax
}

/**
 * Find the overall gain that puts the soft-clipped sound on `lufs` (the target plus the correction the MP3 encode
 * needs), with peaks held under `ceiling` dBFS.
 */
function calibrate(x, recipe, frames, lufs, ceiling, start = 1) {
  const probe = (g) => {
    const y = levelAndClip(x, g, ceiling)
    return { y, l: loudness(recipe.loop ? repeat(y, 2) : y, frames) }
  }
  let g = start
  let { y, l } = probe(g)
  for (let pass = 0; pass < MAX_PASSES && Math.abs(lufs - l) > LEVEL_EPS; pass++) {
    g *= dbToGain(lufs - l)
    ;({ y, l } = probe(g))
  }
  return { y, gain: g }
}

function encode(y, file) {
  ffmpeg([
    '-v', 'error', ...PCM_IN,
    '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'libmp3lame', '-b:a', BITRATE,
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-id3v2_version', '0', '-write_xing', '0',
    file,
  ], pcm(y))
}

/** Measure a finished MP3. `frames` = the rendered length (a short cue's loudness is spread over that length). */
function measureFile(file, frames) {
  const { lufsMax, truePeak } = measureEbu(file)
  if (frames >= MOMENTARY_WINDOW_S * SR) return { lufsMax, truePeak, measuredOn: 'momentary' }
  return { lufsMax: wholeLoudness(decode(file), frames), truePeak, measuredOn: 'whole' }
}

function build(recipe, args) {
  const name = recipe.cue ?? recipe.loop
  const x = render(recipe)
  const frames = recipe.loop ? x.length * 2 : x.length
  const file = path.join(args.out, recipe.file)
  const offset = args.offsets[name] ?? 0
  // The MP3 encode shifts loudness (its lowpass takes off highs the K-weighting counts) and adds a little peak: level
  // the PCM, encode, measure the MP3, and level again with the difference until the MP3 itself is on target.
  let aim = recipe.target.lufs
  let ceiling = recipe.target.peak - CLIP_MARGIN_DB
  let gain = 1
  let m
  for (let pass = 0; pass < 4; pass++) {
    const c = calibrate(x, recipe, frames, aim, ceiling, gain)
    gain = c.gain
    const finished = offset === 0 ? c.y : c.y.map((v) => v * dbToGain(offset))
    encode(recipe.loop ? repeat(finished, 2) : finished, file)
    m = measureFile(file, frames)
    if (offset !== 0) break
    const over = m.truePeak - Math.min(recipe.target.peak, -1)
    const off = recipe.target.lufs - m.lufsMax
    if (over <= 0 && Math.abs(off) <= 2 * LEVEL_EPS) break
    if (over > 0) ceiling -= over + 0.2
    aim += off
  }
  const entry = {
    file: recipe.file,
    bytes: fs.statSync(file).size,
    duration: round(frames / SR, 3),
    lufsMax: round(m.lufsMax, 1),
    truePeak: round(m.truePeak, 1),
    measuredOn: m.measuredOn,
    target: recipe.target,
    sources: [...new Set(recipe.layers.map((l) => l.src))],
    ...(recipe.loop ? { period: recipe.period, crossfade: recipe.crossfade } : {}),
  }
  console.log(`${name.padEnd(18)} ${String(entry.bytes).padStart(7)} B  ${entry.duration} s  gain ${round(20 * Math.log10(gain), 1)} dB  ` +
    `${entry.lufsMax} LUFS ${m.measuredOn} (target ${recipe.target.lufs})  peak ${entry.truePeak} dBTP (cap ${recipe.target.peak})`)
  return entry
}

/** Level problems of every cue and loop in a report. */
export function reportProblems(report) {
  return levelProblems({ ...(report.cues ?? {}), ...Object.fromEntries(Object.entries(report.loops ?? {}).map(([k, v]) => [`loop ${k}`, v])) })
}

function fail(problems) {
  for (const p of problems) console.error(`off target: ${p}`)
  process.exitCode = 1
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.check) {
    const problems = reportProblems(JSON.parse(fs.readFileSync(args.check, 'utf8')))
    if (problems.length) fail(problems)
    else console.log(`${path.relative(ROOT, args.check)}: every file within 1.5 LU of its target`)
    return
  }
  checkLicences()
  fs.mkdirSync(args.out, { recursive: true })
  const pick = (r) => !args.only || args.only.has(r.cue ?? r.loop)
  const version = String(run('ffmpeg', ['-version']).stdout).split('\n')[0].replace(/ Copyright.*/, '')
  const cues = {}
  const loops = {}
  const sources = {}
  let total = 0
  for (const recipe of [...RECIPES, ...LOOPS].filter(pick)) {
    for (const l of recipe.layers) sources[l.src] = sha256(sourcePath(l.src))
    const entry = build(recipe, args)
    total += entry.bytes
    if (recipe.loop) loops[recipe.loop] = entry
    else cues[recipe.cue] = entry
  }
  const report = {
    generator: 'scripts/sounds/build.mjs',
    ffmpeg: version,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    bitrate: BITRATE,
    totalBytes: total,
    cues,
    loops,
    sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))),
  }
  fs.mkdirSync(path.dirname(args.report), { recursive: true })
  fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + '\n')
  console.log(`total ${total} bytes -> ${path.relative(ROOT, args.out) || '.'}, report ${path.relative(ROOT, args.report)}`)
  const problems = reportProblems(report)
  if (problems.length) fail(problems)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  }
}
