import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildTeamVM } from './view-model'
import { makeFixtureState } from './fixtures/sample'

const NOW = new Date(2026, 10, 13, 12, 0, 0).getTime()
const fixture = () => makeFixtureState('revamp-ui', NOW)

test('counts stages, tasks and open decisions', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  assert.equal(vm.stagesDone, 2)
  assert.equal(vm.stagesTotal, 4)
  assert.equal(vm.tasksDone, 2)
  assert.equal(vm.tasksTotal, 8)
  assert.equal(vm.openDecisions, 2)
})

test('one dot per task: done, running, review, others empty', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  assert.deepEqual(vm.dots, ['d', 'd', 'r', 'r', 'v', '', '', ''])
})

test('live holds running, review and blocked in task order; queue holds todo before done', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  assert.deepEqual(vm.live.map((t) => t.statusLabel), ['Dikerjain', 'Dikerjain', 'Di-review', 'Ketahan'])
  assert.deepEqual(vm.queue.map((t) => t.statusLabel), ['Antri', 'Antri', 'Selesai', 'Selesai'])
})

test('an unknown task status counts as waiting, not hidden', () => {
  const vm = buildTeamVM({ tasks: { x: { title: 'Aneh', status: 'lagi-mikir', order: 1 } } }, { now: NOW })
  assert.equal(vm.queue.length, 1)
  assert.equal(vm.queue[0].statusLabel, 'Antri')
})

test('long titles are kept whole (O3)', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  const long = vm.live[0].title
  assert.ok(long.length > 150)
  assert.ok(!long.includes('…') && !long.includes('...'))
  assert.ok(vm.title.endsWith('tanpa ada judul yang terpotong'))
  const kaito = vm.members.find((m) => m.nick === 'Kaito')
  assert.ok(kaito && kaito.task.endsWith('tombol bagikan'))
})

test('a member working on a task key shows the task title, never the key (O2)', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  const yuki = vm.members.find((m) => m.nick === 'Yuki')
  assert.ok(yuki)
  assert.ok(yuki.task.startsWith('Merombak seluruh halaman Explore'))
  assert.notEqual(yuki.task, 'tm03')
})

test('no id, key or code appears in anything the viewer reads (O2)', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  const shown = JSON.stringify({
    ...vm,
    decisions: vm.decisions.map(({ id: _id, ...rest }) => rest),
    live: vm.live.map(({ id: _id, ...rest }) => rest),
    queue: vm.queue.map(({ id: _id, ...rest }) => rest),
    members: vm.members.map(({ id: _id, ...rest }) => rest),
    lead: vm.lead && (({ id: _id, ...rest }) => rest)(vm.lead),
    stages: vm.stages.map(({ id: _id, ...rest }) => rest),
    log: vm.log.map(({ id: _id, ...rest }) => rest),
  })
  assert.ok(!/\btm0\d\b/.test(shown), 'task key leaked')
  assert.ok(!/"D[0-9]"/.test(shown), 'decision key leaked')
  assert.ok(!/"a[1-7]"/.test(shown), 'agent id leaked')
})

test('the coordinator is the lead; everyone else is a member in order', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  assert.equal(vm.lead?.nick, 'Sora')
  assert.deepEqual(vm.members.map((m) => m.nick), ['Yuki', 'Aoi', 'Kaito', 'Mei', 'Rin', 'Hana'])
  assert.equal(vm.lead?.tone, 'lead')
  assert.equal(vm.members[0].tone, 'sonnet')
  assert.equal(vm.members[2].tone, 'opus')
})

test('idle members show no task; working members show theirs', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  const aoi = vm.members.find((m) => m.nick === 'Aoi')
  assert.equal(aoi?.working, false)
  assert.equal(aoi?.task, '')
  assert.equal(vm.members.find((m) => m.nick === 'Mei')?.task, 'Review filter kategori')
})

test('member role is the standard role name and the model its own field; no desk label (V-01, V-02)', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  assert.equal(vm.lead?.role, 'Software Architect')
  assert.equal(vm.members.find((m) => m.nick === 'Mei')?.role, 'Code Reviewer')
  const yuki = vm.members.find((m) => m.nick === 'Yuki')
  assert.equal(yuki?.role, 'Software Engineer')
  assert.equal(yuki?.model, 'Sonnet 5.5')
  const shown = JSON.stringify([vm.lead, ...vm.members])
  for (const w of ['Pembuat', 'Koordinator', 'Penilai', 'builder', 'coordinator', 'grader']) {
    assert.ok(!shown.includes(w), `${w} leaked`)
  }
})

test('a task shows who works on it as "nick · model", or nothing when unassigned', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  assert.equal(vm.live[0].who, 'Yuki · Sonnet 5.5')
  assert.equal(vm.queue.find((t) => t.title === 'Tabel pengguna di admin')?.who, '')
})

test('decisions: open first, then answered; recommended option marked with the coordinator', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  assert.deepEqual(vm.decisions.map((d) => d.open), [true, true, false])
  const d = vm.decisions[0]
  assert.deepEqual(d.options.map((o) => o.recommended), [false, true, false])
  assert.equal(d.recommendedBy, 'Saran Sora')
})

test('an open decision jumps ahead of an answered one even when its order is later', () => {
  const vm = buildTeamVM(
    {
      approvals: {
        D1: { title: 'Sudah', status: 'answered', answer: 'ya', order: 1 },
        D2: { title: 'Belum', status: 'open', order: 2 },
      },
    },
    { now: NOW },
  )
  assert.deepEqual(vm.decisions.map((d) => d.title), ['Belum', 'Sudah'])
})

test('an answered decision shows the answer the server overlaid', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  assert.equal(vm.decisions[2].answer, 'Hijau tua')
  assert.equal(vm.openDecisions, 2)
})

test('an answer just sent from this browser closes the decision before the server echoes it', () => {
  const vm = buildTeamVM(fixture(), { now: NOW, localAnswers: { D1: '10 MB' } })
  const d = vm.decisions.find((x) => x.answer === '10 MB')
  assert.ok(d)
  assert.equal(d.open, false)
  assert.equal(vm.openDecisions, 1)
})

test('a decision with an answer but a stale "open" status still counts as answered', () => {
  const vm = buildTeamVM({ approvals: { D9: { title: 'X', status: 'open', answer: 'ya' } } }, { now: NOW })
  assert.equal(vm.decisions[0].open, false)
})

test('stage progress is a clamped percent; done shows a check, others their number', () => {
  const vm = buildTeamVM(fixture(), { now: NOW })
  assert.deepEqual(vm.stages.map((s) => s.percent), [100, 100, 45, 0])
  assert.deepEqual(vm.stages.map((s) => s.marker), ['✓', '✓', '3', '4'])
  const odd = buildTeamVM({ stages: { a: { label: 'A', order: 1, status: 'active', progress: 7 } } }, { now: NOW })
  assert.equal(odd.stages[0].percent, 100)
})

test('log shows the newest 20 first with relative time', () => {
  const log: Record<string, { t: string; text: string }> = {}
  for (let i = 0; i < 25; i++) log[`e${i}`] = { t: new Date(NOW - i * 3_600_000).toISOString(), text: `kejadian ${i}` }
  const vm = buildTeamVM({ log }, { now: NOW })
  assert.equal(vm.log.length, 20)
  assert.equal(vm.log[0].text, 'kejadian 0')
  assert.equal(vm.log[0].time, 'baru saja')
  assert.equal(vm.log[1].time, '1 jam lalu')
})

test('survives empty and broken state', () => {
  for (const s of [null, undefined, {}, { tasks: 'oops', stages: [], agents: null }] as never[]) {
    const vm = buildTeamVM(s, { now: NOW, projectName: 'Proyek A' })
    assert.equal(vm.title, 'Proyek A')
    assert.equal(vm.tasksTotal, 0)
    assert.equal(vm.lead, null)
  }
})

test('status text falls back to a plain label of meta.status', () => {
  assert.equal(buildTeamVM({ meta: { status: 'paused' } }, { now: NOW }).statusText, 'Dijeda')
  assert.equal(buildTeamVM({ meta: { status: 'paused', statusText: 'Nunggu kamu' } }, { now: NOW }).statusText, 'Nunggu kamu')
})
