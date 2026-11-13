import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentLabelBottom } from './agent-label'

test('a short name needs one line below the hexagon', () => {
  const b = agentLabelBottom('Sesi utama', 28, false)
  assert.equal(b, 28 + 8 + 12)
})

test('a long title reaches further down than a short one', () => {
  const short = agentLabelBottom('abc', 28, true)
  const long = agentLabelBottom('kata '.repeat(40), 28, true)
  assert.ok(long > short + 12 * 5, `${long} vs ${short}`)
})

test('the context bar pushes the name lower', () => {
  assert.ok(agentLabelBottom('abc', 28, true) > agentLabelBottom('abc', 28, false))
})
