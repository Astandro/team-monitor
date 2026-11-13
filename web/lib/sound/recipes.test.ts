import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SoundCue } from './cues'
import { driveCurve, RECIPES, recipeDuration, recipeLevel, recipePeak, stepTimes } from './recipes'

const ALL = Object.keys(RECIPES) as SoundCue[]

/** Length of each sound in seconds (end of its last voice), as the spec v2 asks. */
const DURATION_RANGE: Record<SoundCue, [number, number]> = {
  tool_start: [0.01, 0.06], // very short tick
  tool_complete: [0.01, 0.06], // very short blip
  handoff: [0.1, 0.3],
  agent_spawn: [0.25, 0.6],
  agent_complete: [0.6, 1.4], // soft tail
  tool_error: [0.25, 0.6],
  agent_offboarded: [1.0, 2.0],
  session_start: [1.7, 2.3], // about 2 s
  decision_open: [0.8, 1.6],
  decision_answered: [0.5, 1.2],
  task_start: [0.3, 0.8],
  task_review: [0.3, 0.8],
  task_done: [0.6, 1.2],
  task_blocked: [0.3, 0.6],
  stage_done: [2.2, 2.8], // about 2.5 s
}

/** Caps on loudness before the master bus. */
const MAX_VOICE_PEAK = 0.3
const MAX_LEVEL = 1
const FREQUENT: readonly SoundCue[] = ['tool_start', 'tool_complete', 'handoff']
const FREQUENT_MAX_LEVEL = 0.04
const GRAPH_AGENT: readonly SoundCue[] = ['agent_spawn', 'agent_complete']
const GRAPH_AGENT_MAX_LEVEL = 0.2
const RARE_EPIC: readonly SoundCue[] = ['session_start', 'stage_done']

test('every cue lasts as long as the spec says', () => {
  for (const c of ALL) {
    const [min, max] = DURATION_RANGE[c]
    const d = recipeDuration(RECIPES[c])
    assert.ok(d >= min && d <= max, `${c} lasts ${d.toFixed(3)} s, expected ${min}..${max}`)
  }
})

test('only the rare events get the big, long sounds', () => {
  const long = ALL.filter((c) => recipeDuration(RECIPES[c]) > 1.6).sort()
  assert.deepEqual(long, [...RARE_EPIC].sort())
  // and the tool blips are the shortest of all
  const blip = Math.max(recipeDuration(RECIPES.tool_start), recipeDuration(RECIPES.tool_complete))
  for (const c of ALL) if (c !== 'tool_start' && c !== 'tool_complete') assert.ok(recipeDuration(RECIPES[c]) > blip, c)
})

test('peak caps: no voice and no moment is louder than the caps', () => {
  for (const c of ALL) {
    assert.ok(recipePeak(RECIPES[c]) <= MAX_VOICE_PEAK, `${c} voice peak ${recipePeak(RECIPES[c])}`)
    assert.ok(recipeLevel(RECIPES[c]) <= MAX_LEVEL, `${c} level ${recipeLevel(RECIPES[c])}`)
    for (const v of RECIPES[c]) {
      assert.ok(v.peak > 0, c)
      assert.ok((v.space ?? 0) >= 0 && (v.space ?? 0) <= 1, c)
      assert.ok((v.drive ?? 0) >= 0 && (v.drive ?? 0) <= 1, c)
    }
  }
})

test('frequent sounds stay quiet and dry', () => {
  for (const c of FREQUENT) {
    assert.ok(recipeLevel(RECIPES[c]) <= FREQUENT_MAX_LEVEL, `${c} level ${recipeLevel(RECIPES[c])}`)
    for (const v of RECIPES[c]) assert.ok(!v.space, `${c} sends to the reverb`)
  }
  for (const c of GRAPH_AGENT) assert.ok(recipeLevel(RECIPES[c]) <= GRAPH_AGENT_MAX_LEVEL, `${c} level ${recipeLevel(RECIPES[c])}`)
})

test('a waiting decision is the loudest sound apart from the two rare epic ones', () => {
  const open = recipeLevel(RECIPES.decision_open)
  for (const c of ALL) {
    if (c === 'decision_open' || RARE_EPIC.includes(c)) continue
    assert.ok(recipeLevel(RECIPES[c]) < open, `${c} ${recipeLevel(RECIPES[c])} >= decision_open ${open}`)
  }
  // it pulses: at least three separate onsets of its main tone
  const onsets = new Set(RECIPES.decision_open.map((v) => v.start))
  assert.ok(onsets.size >= 3)
})

test('recipeLevel sums only the voices sounding together', () => {
  const v = (start: number, dur: number, peak: number) => ({ type: 'sine' as const, freq: 440, start, dur, peak, attack: 0.01 })
  assert.ok(Math.abs(recipeLevel([v(0, 1, 0.1), v(0.5, 1, 0.2)]) - 0.3) < 1e-9)
  assert.equal(recipeLevel([v(0, 0.4, 0.1), v(0.5, 1, 0.2)]), 0.2)
})

test('the sound design uses the space-opera building blocks', () => {
  const voices = ALL.flatMap((c) => RECIPES[c])
  assert.ok(voices.some((v) => v.type === 'noise' && v.filter?.to), 'filtered noise sweep')
  assert.ok(voices.some((v) => v.fm), 'FM metal')
  assert.ok(voices.some((v) => v.ring), 'ring modulation')
  assert.ok(voices.some((v) => v.steps && v.steps.length >= 3 && v.type === 'square'), 'stepped square chatter')
  assert.ok(voices.some((v) => v.drive && v.to && v.to < v.freq), 'distorted pitch drop')
  assert.ok(voices.some((v) => v.type === 'sine' && v.freq < 80), 'sub-bass')
  assert.ok(voices.some((v) => (v.space ?? 0) > 0), 'reverb')
  // the rocket: crack plus a long noise swell; the stage: a whoosh into an impact
  assert.ok(RECIPES.session_start.some((v) => v.type === 'noise' && v.dur > 1.5 && (v.attack ?? 0) > 1))
  const whoosh = RECIPES.stage_done.find((v) => v.type === 'noise' && (v.attack ?? 0) > 0.8)
  assert.ok(whoosh)
  assert.ok(RECIPES.stage_done.some((v) => v.type === 'sine' && v.freq < 80 && Math.abs(v.start - (whoosh.start + whoosh.dur) ) < 0.1))
})

test('drive curve: silent at zero, clipped softly to +-1, harder with more drive', () => {
  const soft = driveCurve(0.1, 101)
  const hard = driveCurve(1, 101)
  assert.equal(soft[50], 0)
  assert.ok(Math.abs(hard[100] - 1) < 1e-6 && Math.abs(hard[0] + 1) < 1e-6)
  // at a quarter of full scale the hard curve is already near the top
  assert.ok(hard[62] > soft[62])
  for (const x of hard) assert.ok(x >= -1.000001 && x <= 1.000001)
})

test('stepped voices split their time evenly', () => {
  assert.deepEqual(stepTimes({ steps: [100, 200, 300, 400], dur: 0.2 }).map((s) => +s.at.toFixed(3)), [0, 0.05, 0.1, 0.15])
  assert.deepEqual(stepTimes({ dur: 1 }), [])
})
