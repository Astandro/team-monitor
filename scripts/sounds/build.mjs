#!/usr/bin/env node
// Builds sound set v3 (web/public/sounds/sfx-*.mp3) from CC0 sample packs with ffmpeg, following recipes.mjs, and
// writes the build report web/lib/sound/sample-report.json (length, loudness, true peak, size per sound) that the
// app and its tests read.
//
//   node scripts/sounds/build.mjs --pack scifi=<Kenney Sci-Fi Sounds folder> \
//     --pack interface=<Kenney Interface Sounds folder> --work <empty temp folder> [--renders <folder>]
//
// A pack folder is the extracted archive (it holds License.txt and Audio/). The packs are not in the repo; where to
// get them is in web/public/sounds/LICENSES.md. Only audio files are read from them (ffmpeg/ffprobe by path).
// --renders also writes each finished sound as a WAV to listen to. Needs ffmpeg with libmp3lame on PATH.
//
// Level: each sound is first mixed at unity, then measured (EBU R128 momentary maximum and true peak), then
// turned up or down to its target loudness without passing its peak cap, then a limiter holds the cap.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BITRATE, PACKS, RECIPES, SAMPLE_RATE } from './recipes.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_DIR = path.join(ROOT, 'web', 'public', 'sounds')
const REPORT = path.join(ROOT, 'web', 'lib', 'sound', 'sample-report.json')

/** Pad short sounds with silence before measuring, so the 400 ms loudness window sees all of them. */
const MEASURE_PAD = 0.5
/** Head room kept under the peak cap before the limiter (MP3 encoding can add a little peak). */
const LIMIT_MARGIN_DB = 1
/** afir normalises the impulse, so its output sits well under the dry signal: space.mix 1 = this much wet. */
const REVERB_GAIN = 4

function parseArgs(argv) {
  const args = { packs: {}, work: null, renders: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    if (a === '--pack' && v) {
      const eq = v.indexOf('=')
      if (eq < 1) throw new Error(`--pack wants name=folder, got ${v}`)
      args.packs[v.slice(0, eq)] = path.resolve(v.slice(eq + 1))
      i++
    } else if (a === '--work' && v) {
      args.work = path.resolve(v)
      i++
    } else if (a === '--mix-only' && v) {
      // QA: only mix one cue into the work folder (no MP3, no report), to try a recipe change quickly
      args.mixOnly = v
      i++
    } else if (a === '--renders' && v) {
      args.renders = path.resolve(v)
      i++
    } else {
      throw new Error(`unknown argument ${a}`)
    }
  }
  if (!args.work) throw new Error('--work <folder> is required')
  for (const name of Object.keys(PACKS)) if (!args.packs[name]) throw new Error(`--pack ${name}=<folder> is required`)
  return args
}

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}):\n${(r.stderr || '').slice(-3000)}`)
  return r
}

function ffmpeg(argv) {
  return run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...argv])
}

function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', file])
  const j = JSON.parse(r.stdout)
  const s = j.streams[0]
  return { duration: Number(j.format.duration), sampleRate: Number(s.sample_rate), channels: Number(s.channels) }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d

/** Check every pack's licence file says CC0 before any of its audio is touched. */
function checkLicences(packs) {
  for (const [name, pack] of Object.entries(PACKS)) {
    const file = path.join(packs[name], pack.licenceFile)
    const text = fs.readFileSync(file, 'utf8')
    if (!/Creative Commons Zero, CC0/.test(text) || !text.includes('creativecommons.org/publicdomain/zero/1.0')) {
      throw new Error(`${file} does not state CC0: refusing to use pack "${name}"`)
    }
  }
}

function sourcePath(packs, src) {
  const [pack, file] = src.split('/')
  if (!PACKS[pack] || !file || src.split('/').length !== 2 || !/^[A-Za-z0-9_.-]+\.(ogg|wav|mp3)$/.test(file)) {
    throw new Error(`bad source ${src}`)
  }
  return path.join(packs[pack], PACKS[pack].audioDir, file)
}

/** Seeded stereo impulse of a large dark space, decaying 60 dB over `seconds`. */
function impulse(work, seconds) {
  const file = path.join(work, `ir-${seconds}.wav`)
  if (fs.existsSync(file)) return file
  const n = (seed) => `anoisesrc=d=${seconds}:c=pink:r=${SAMPLE_RATE}:a=0.5:s=${seed}`
  const decay = `exp(-6.9*t/${seconds})`
  ffmpeg([
    '-f', 'lavfi', '-i', n(11), '-f', 'lavfi', '-i', n(12),
    '-filter_complex', `[0:a][1:a]amerge=inputs=2,aeval='val(0)*${decay}|val(1)*${decay}',lowpass=f=5000`,
    '-c:a', 'pcm_f32le', file,
  ])
  return file
}

/** Equal-power pan, optionally gliding from `pan` to `panTo` over `len` seconds. */
function panFilter(pan = 0, panTo = pan, len) {
  const p = `(${pan}+(${panTo - pan})*min(t/${Math.max(len, 0.001)},1))`
  return `aeval='val(0)*cos((${p}+1)*PI/4)|val(1)*sin((${p}+1)*PI/4)':c=stereo`
}

/** Filter chain for one layer; returns its output label and its length in the mix. */
function layerChain(layer, index, info, dur) {
  const rate = layer.rate ?? 1
  const from = layer.from ?? 0
  const to = Math.min(layer.to ?? info.duration, info.duration)
  const len = (to - from) / rate
  const at = layer.endAt !== undefined ? layer.endAt - len : (layer.at ?? 0)
  if (at < 0) throw new Error(`layer ${layer.src} would start before 0`)
  const f = [`atrim=start=${from}:end=${to}`, 'asetpts=PTS-STARTPTS']
  if (layer.reverse) f.push('areverse')
  if (rate !== 1) f.push(`asetrate=${Math.round(info.sampleRate * rate)}`)
  f.push(`aresample=${SAMPLE_RATE}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo')
  for (const x of layer.filters ?? []) f.push(x)
  if (layer.fadeIn) f.push(`afade=t=in:d=${layer.fadeIn}`)
  if (layer.fadeOut) f.push(`afade=t=out:st=${Math.max(0, len - layer.fadeOut)}:d=${layer.fadeOut}`)
  if (layer.gain) f.push(`volume=${layer.gain}dB`)
  f.push(panFilter(layer.pan, layer.panTo, len))
  if (at > 0) f.push(`adelay=${Math.round(at * 1000)}:all=1`)
  // every layer is padded to the full length: amix + apad after it ended the mix early on ffmpeg 9
  f.push(`apad=whole_dur=${dur}`, `atrim=end=${dur}`)
  return { chain: `[${index}:a]${f.join(',')}[l${index}]`, label: `[l${index}]`, end: at + len }
}

/** Mix a cue at unity gain (layers, reverb, final fade) into a float WAV. */
function mixCue(recipe, packs, work) {
  const inputs = []
  const chains = []
  const labels = []
  recipe.layers.forEach((layer, i) => {
    const file = sourcePath(packs, layer.src)
    inputs.push('-i', file)
    const c = layerChain(layer, i, probe(file), recipe.dur)
    if (c.end > recipe.dur + 1e-6) throw new Error(`${recipe.cue}: layer ${layer.src} ends at ${round(c.end)} s, after dur ${recipe.dur}`)
    chains.push(c.chain)
    labels.push(c.label)
  })
  const { mix, seconds, predelay } = recipe.space
  const ir = recipe.layers.length
  inputs.push('-i', impulse(work, seconds))
  const dur = recipe.dur
  const tailFade = Math.min(0.4, dur * 0.25)
  chains.push(
    `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first[dry]`,
    `[dry]asplit=2[d][s]`,
    `[s]adelay=${Math.round(predelay * 1000)}:all=1,atrim=end=${dur}[sd]`,
    `[sd][${ir}:a]afir=dry=10:wet=10[w]`,
    `[w]volume=${round(mix * REVERB_GAIN, 3)}[wet]`,
    `[d][wet]amix=inputs=2:normalize=0:duration=first,highpass=f=25,afade=t=out:st=${round(dur - tailFade, 3)}:d=${tailFade},atrim=end=${dur}[out]`,
  )
  const file = path.join(work, `${recipe.cue}-mix.wav`)
  fs.writeFileSync(path.join(work, `${recipe.cue}-graph.txt`), `${inputs.join(' ')}\n\n${chains.join(';\n')}\n`)
  ffmpeg([...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_f32le', file])
  return file
}

/** EBU R128 momentary maximum (LUFS) and true peak (dBTP) of a file. */
function measure(file) {
  const r = ffmpeg(['-nostats', '-v', 'verbose', '-i', file, '-af', `apad=pad_dur=${MEASURE_PAD},ebur128=peak=true:framelog=verbose`, '-f', 'null', '-'])
  const err = r.stderr
  let lufsMax = -Infinity
  for (const m of err.matchAll(/ M:\s*(-?[0-9.]+|-inf)/g)) {
    const v = Number(m[1])
    if (Number.isFinite(v) && v > lufsMax) lufsMax = v
  }
  const tp = err.match(/True peak:\s*\n\s*Peak:\s*(-?[0-9.]+|-inf) dBFS/)
  const truePeak = tp ? Number(tp[1]) : NaN
  if (!Number.isFinite(lufsMax) || !Number.isFinite(truePeak)) throw new Error(`could not measure ${file}`)
  return { lufsMax, truePeak }
}

function finish(recipe, mixFile, work) {
  const raw = measure(mixFile)
  const capLimit = recipe.target.peak - LIMIT_MARGIN_DB
  const gain = Math.min(recipe.target.lufs - raw.lufsMax, capLimit - raw.truePeak + 3)
  // alimiter only limits down to -24 dB: limit at -1 dB with the signal lifted, then bring it down to the cap
  const lift = -1 - capLimit
  const out = path.join(OUT_DIR, recipe.file)
  ffmpeg([
    '-i', mixFile,
    '-af', `volume=${round(gain + lift, 2)}dB,alimiter=limit=${(10 ** (-1 / 20)).toFixed(5)}:level=0:attack=2:release=60:latency=1,volume=${round(-lift, 2)}dB`,
    '-ar', String(SAMPLE_RATE), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', BITRATE,
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-id3v2_version', '0', '-write_xing', '0',
    out,
  ])
  const final = measure(out)
  return { file: out, raw, gain, final }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  checkLicences(args.packs)
  fs.mkdirSync(args.work, { recursive: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })
  if (args.renders) fs.mkdirSync(args.renders, { recursive: true })
  if (args.mixOnly) {
    const recipe = RECIPES.find((r) => r.cue === args.mixOnly)
    if (!recipe) throw new Error(`no recipe ${args.mixOnly}`)
    const file = mixCue(recipe, args.packs, args.work)
    console.log(file, measure(file))
    return
  }

  const version = run('ffmpeg', ['-version']).stdout.split('\n')[0].replace(/ Copyright.*/, '')
  const cues = {}
  const sources = {}
  let total = 0
  RECIPES.forEach((recipe, n) => {
    for (const l of recipe.layers) sources[l.src] = sha256(sourcePath(args.packs, l.src))
    const mixFile = mixCue(recipe, args.packs, args.work)
    const { file, final } = finish(recipe, mixFile, args.work)
    const bytes = fs.statSync(file).size
    total += bytes
    const duration = probe(file).duration
    cues[recipe.cue] = {
      file: recipe.file,
      bytes,
      duration: round(duration, 3),
      lufsMax: round(final.lufsMax, 1),
      truePeak: round(final.truePeak, 1),
      target: recipe.target,
      sources: [...new Set(recipe.layers.map((l) => l.src))],
    }
    if (args.renders) {
      const wav = path.join(args.renders, `${String(n + 1).padStart(2, '0')}-${recipe.cue}.wav`)
      ffmpeg(['-i', file, '-c:a', 'pcm_s16le', wav])
    }
    console.log(`${recipe.cue.padEnd(18)} ${String(bytes).padStart(7)} B  ${round(duration, 2)} s  ` +
      `${round(final.lufsMax, 1)} LUFS (target ${recipe.target.lufs})  peak ${round(final.truePeak, 1)} dBTP (cap ${recipe.target.peak})`)
  })
  const report = {
    generator: 'scripts/sounds/build.mjs',
    ffmpeg: version,
    sampleRate: SAMPLE_RATE,
    bitrate: BITRATE,
    totalBytes: total,
    cues,
    sources,
  }
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n')
  console.log(`total ${total} bytes -> ${path.relative(ROOT, OUT_DIR)}, report ${path.relative(ROOT, REPORT)}`)
}

main()
