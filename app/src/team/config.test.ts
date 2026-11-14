import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildRegistry, readConfigProjects, slugify, teamHome } from './config'
import { makeTmpDir, removeTmpDir } from './test-helpers'

test('teamHome honours TEAM_MONITOR_HOME', () => {
  assert.equal(teamHome({ TEAM_MONITOR_HOME: '/tmp/x' }), path.resolve('/tmp/x'))
  assert.equal(teamHome({}), path.join(os.homedir(), '.team-monitor'))
})

test('slugify makes safe ids', () => {
  assert.equal(slugify('My App Web'), 'my-app-web')
  assert.equal(slugify('../..'), 'project')
  assert.equal(slugify('Café_ß'), 'cafe')
})

test('registry: config plus --project, existing folders only, unique ids, no duplicates', () => {
  const root = makeTmpDir()
  try {
    for (const d of ['a/web', 'b/web', 'other']) fs.mkdirSync(path.join(root, d), { recursive: true })
    fs.writeFileSync(path.join(root, 'file'), '')
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      projects: [
        { id: 'kerja', name: 'Kerja', path: path.join(root, 'a/web') },
        { id: 'Bad Id!', path: path.join(root, 'b/web') },
        { path: path.join(root, 'missing') },
        { path: path.join(root, 'file') },
        'junk',
      ],
    }))
    const reg = buildRegistry(readConfigProjects(home, () => {}), [path.join(root, 'other'), path.join(root, 'a/web')])
    assert.deepEqual(reg.map((p) => [p.id, p.name]), [['kerja', 'Kerja'], ['web', 'web'], ['other', 'other']])

    const reg2 = buildRegistry([], [path.join(root, 'a/web'), path.join(root, 'b/web')])
    assert.deepEqual(reg2.map((p) => p.id), ['web', 'web-2'])
  } finally {
    removeTmpDir(root)
  }
})

test('a broken config.json is reported and ignored', () => {
  const root = makeTmpDir()
  try {
    fs.writeFileSync(path.join(root, 'config.json'), '{nope')
    const warnings: string[] = []
    assert.deepEqual(readConfigProjects(root, (m) => warnings.push(m)), [])
    assert.equal(warnings.length, 1)
    assert.deepEqual(readConfigProjects(path.join(root, 'none'), (m) => warnings.push(m)), [])
    assert.equal(warnings.length, 1, 'a missing config is not an error')
  } finally {
    removeTmpDir(root)
  }
})
