import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentDisplayName, toolLabel,toolCallLine, hasDistinctToolName, stateLabel, toolStateLabel, agentStateLabel } from './readable-labels'

test('known tools map to plain Indonesian labels', () => {
  assert.equal(toolLabel('Bash'), 'Jalanin perintah')
  assert.equal(toolLabel('Read'), 'Baca file')
  assert.equal(toolLabel('Write'), 'Tulis file')
  assert.equal(toolLabel('Edit'), 'Ubah file')
  assert.equal(toolLabel('Agent'), 'Kirim agent')
  assert.equal(toolLabel('Task'), 'Kirim agent')
  assert.equal(toolLabel('Grep'), 'Cari isi file')
  assert.equal(toolLabel('Glob'), 'Cari nama file')
  assert.equal(toolLabel('WebSearch'), 'Cari di web')
  assert.equal(toolLabel('exec_command'), 'Jalanin perintah')
})

test('every tool the task lists has a label that differs from the raw name', () => {
  const names = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob', 'LS', 'Agent', 'Task', 'WebFetch',
    'WebSearch', 'TodoWrite', 'NotebookEdit', 'Skill', 'ToolSearch', 'SendMessage', 'Monitor', 'AskUserQuestion']
  for (const n of names) {
    assert.notEqual(toolLabel(n), n, `${n} still shown raw`)
    assert.ok(toolLabel(n).includes(' '), `${n} label should be words`)
  }
})

test('MCP tool names become "Alat <server>: <tool>" with underscores as spaces and no mcp__ prefix', () => {
  assert.equal(toolLabel('mcp__claude_ai_Gmail__search_threads'), 'Alat claude ai Gmail: search threads')
  assert.equal(toolLabel('mcp__slack__post_message'), 'Alat slack: post message')
  for (const n of ['mcp__a__b', 'mcp__server_x__do_thing', 'mcp__only', 'mcp__']) {
    const out = toolLabel(n)
    assert.ok(!out.includes('mcp__'), out)
    assert.ok(!out.includes('_'), out)
  }
  assert.equal(toolLabel('mcp__only'), 'Alat only')
})

test('unknown tools fall back to words, never a raw code', () => {
  assert.equal(toolLabel('SomeNewTool'), 'Some new tool')
  assert.equal(toolLabel('do_the_thing'), 'Do the thing')
  assert.equal(toolLabel(''), 'Alat')
  assert.equal(toolLabel(undefined), 'Alat')
  assert.ok(!toolLabel('weird_name-v2').includes('_'))
})

test('toolCallLine joins label and args; hasDistinctToolName flags renamed tools', () => {
  assert.equal(toolCallLine('Read', 'a/b.ts'), 'Baca file: a/b.ts')
  assert.equal(toolCallLine('Read'), 'Baca file')
  assert.equal(hasDistinctToolName('Bash'), true)
  assert.equal(hasDistinctToolName(''), false)
})

test('the main agent reads as "Orchestrator" (owner override, 13 Nov), other names pass through', () => {
  assert.equal(agentDisplayName('orchestrator'), 'Orchestrator')
  assert.equal(agentDisplayName(''), 'Orchestrator')
  assert.equal(agentDisplayName(undefined), 'Orchestrator')
  assert.equal(agentDisplayName('Perbaiki label grafik'), 'Perbaiki label grafik')
  assert.equal(agentDisplayName('orchestrator-2'), 'orchestrator-2')
})

test('state labels are plain Indonesian', () => {
  assert.equal(stateLabel('waiting_permission'), 'Menunggu izin')
  assert.equal(stateLabel('thinking'), 'Berpikir')
  assert.equal(stateLabel('unknown_state'), 'unknown state')
  assert.equal(toolStateLabel('running'), 'Berjalan')
  assert.equal(toolStateLabel('error'), 'Gagal')
})

test('the Orchestrator is never "Selesai" while its session can still wake up; sub-agents still are', () => {
  assert.notEqual(agentStateLabel('complete', true), 'Selesai')
  assert.match(agentStateLabel('complete', true), /Sepi/)
  assert.equal(agentStateLabel('complete', false), 'Selesai')
  assert.equal(agentStateLabel('thinking', true), 'Berpikir')
})
