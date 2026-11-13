import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { encodeProjectPath, matchProjectDir, projectSessionLabel, titleFromState, watchTargets, type WatchedProject } from './session-projects'

const P = (id: string, p: string, extra: Partial<WatchedProject> = {}): WatchedProject => ({ id, name: path.basename(p), path: p, ...extra })

test('a session folder matches its project, and worktrees inside it', () => {
  const hub = P('hub', '/Users/a/projects/my-app')
  const tm = P('tm', '/Users/a/projects/team-monitor')
  const projects = [hub, tm]
  assert.equal(matchProjectDir('-Users-a-projects-my-app', projects), hub)
  assert.equal(matchProjectDir('-Users-a-projects-my-app--claude-worktrees-s2', projects), hub)
  assert.equal(matchProjectDir('-Users-a-projects-team-monitor', projects), tm)
})

test('a sibling folder that only shares a name prefix is not the project', () => {
  const hub = P('hub', '/Users/a/projects/my-app')
  assert.equal(matchProjectDir('-Users-a-projects-my-app-team', [hub]), null)
  assert.equal(matchProjectDir('-Users-a-projects', [hub]), null)
  assert.equal(matchProjectDir('-Users-a-projects-other', [hub]), null)
})

test('nested projects: the most specific one wins, whatever the registry order', () => {
  const outer = P('outer', '/Users/a/projects/mono')
  const inner = P('inner', '/Users/a/projects/mono/apps/web')
  assert.equal(matchProjectDir('-Users-a-projects-mono-apps-web', [outer, inner]), inner)
  assert.equal(matchProjectDir('-Users-a-projects-mono-apps-web', [inner, outer]), inner)
  assert.equal(matchProjectDir('-Users-a-projects-mono', [inner, outer]), outer)
})

test('matching is case-insensitive only where the file system is (Windows), and follows symlinks', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-session-projects-')))
  try {
    const real = path.join(root, 'real-proj')
    fs.mkdirSync(real)
    const link = path.join(root, 'link')
    fs.symlinkSync(real, link)
    assert.equal(encodeProjectPath(link), real.replace(/[^a-zA-Z0-9]/g, '-'))
    const proj = P('p', link)
    assert.equal(matchProjectDir(real.replace(/[^a-zA-Z0-9]/g, '-'), [proj]), proj)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the session label is the project title, else its name, else the folder; never a prompt', () => {
  assert.equal(projectSessionLabel(P('hub', '/x/my-app', { title: '  Revamp UI My App ' })), 'Revamp UI My App')
  assert.equal(projectSessionLabel(P('hub', '/x/my-app', { name: 'My App', title: '   ' })), 'My App')
  assert.equal(projectSessionLabel({ name: '', path: '/x/my-app' }), 'my-app')
})

test('the title comes from state.json meta.title only when it is a real string', () => {
  assert.equal(titleFromState({ meta: { title: 'Revamp UI My App' } }), 'Revamp UI My App')
  assert.equal(titleFromState({ meta: { title: '' } }), undefined)
  assert.equal(titleFromState({ meta: { title: 3 } }), undefined)
  assert.equal(titleFromState({ meta: null }), undefined)
  assert.equal(titleFromState(null), undefined)
})

test('registered projects replace the start folder; without any, the start folder is watched', () => {
  const hub = P('hub', '/Users/a/projects/my-app')
  assert.deepEqual(watchTargets([hub], '/Users/a'), [hub])
  assert.deepEqual(watchTargets([], '/Users/a/projects/my-app'), [{ id: '', name: 'my-app', path: '/Users/a/projects/my-app' }])
})
