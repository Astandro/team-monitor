import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { CUE_PRIORITY } from './cues'
import { CUE_NAMES, DEMO_ORDER, demoLabel, demoSteps } from './demo'
import { cueLength } from './samples'

test('"Coba suara" plays every sound once, each with its own name', () => {
  assert.deepEqual([...DEMO_ORDER].sort(), [...CUE_PRIORITY].sort())
  const names = DEMO_ORDER.map((c) => CUE_NAMES[c])
  for (const n of names) assert.ok(n.trim().length > 0)
  assert.equal(new Set(names).size, names.length)
})

test('demo sounds never overlap, with a gap after each, and the big ones come last', () => {
  const { steps, total } = demoSteps(1)
  assert.equal(steps[0].at, 0)
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1]
    assert.ok(steps[i].at >= prev.at + cueLength(prev.cue) + 1 - 1e-9, steps[i].cue)
  }
  const last = steps[steps.length - 1]
  assert.ok(Math.abs(total - (last.at + cueLength(last.cue) + 1)) < 1e-9)
  assert.equal(last.cue, 'stage_done')
  assert.equal(steps[0].cue, 'tool_start')
})

test('the popover line names the sound and where we are', () => {
  const { steps } = demoSteps()
  assert.equal(demoLabel(steps[12], 12, 15), `${CUE_NAMES.decision_open} (13 dari 15)`)
})
