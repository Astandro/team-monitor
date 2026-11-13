import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  readableCommand, shortDir, isCommandTool, commandText, toolArgsDisplay,
  middleTruncate, middleCut, fitLabelLine,
} from './command-label'

const S = '/private/tmp/claude-1000/-Users-example-developer-account-projects-my-app/00000000-0000-4000-8000-000000000000/scratchpad'

describe('readableCommand: setup is dropped, the action stays (real commands from the team transcripts)', () => {
  const cases: Array<[string, string, string | null]> = [
    ['cd /a/b && npm test', 'npm test', 'b'],
    ['cd /a/b; npm test', 'npm test', 'b'],
    ['cd /a/b ; npm test', 'npm test', 'b'],
    ['cd /a/b\nnpm test', 'npm test', 'b'],
    ['npm test', 'npm test', null],
    ['git status --short', 'git status --short', null],
    // chained &&: everything after the setup is the action
    ['cd /Users/example-developer-account/projects/my-app-team/team-monitor && cat README.md && cat spec-chat.md && cat spec-offboard-names.md',
      'cat README.md && cat spec-chat.md && cat spec-offboard-names.md', 'team-monitor'],
    ['cd /Users/example-developer-account/projects/team-monitor-wt/chat-offboard-ui/web && sed -n 1,209p components/agent-visualizer/top-bar.tsx',
      'sed -n 1,209p components/agent-visualizer/top-bar.tsx', 'web'],
    // pipes stay inside the action
    ['cd /Users/example-developer-account/projects/team-monitor-wt/scifi-sound && node --import tsx --test "web/lib/sound/*.test.ts" 2>&1 | grep -E "^ℹ (pass|fail)|^✖"',
      'node --import tsx --test "web/lib/sound/*.test.ts" 2>&1 | grep -E "^ℹ (pass|fail)|^✖"', 'scifi-sound'],
    ['cd /Users/example-developer-account/projects/my-app-wt/feature-x && npm test 2>&1 | grep -E "^# |^ℹ (tests|pass|fail)|✖" | head -30',
      'npm test 2>&1 | grep -E "^# |^ℹ (tests|pass|fail)|✖" | head -30', 'feature-x'],
    // two cd steps: the last one names the folder
    ['cd /Users/a/projects && cd team-monitor-wt/haze-commands && git log --oneline -3', 'git log --oneline -3', 'haze-commands'],
    // variable, cd, inline env: all setup
    [`S=${S}; cd $S/qa && QA_LOG=$S/logs/s1.log node s1-setup.mjs $S/qa/state.json && cat state.json`,
      'node s1-setup.mjs $S/qa/state.json && cat state.json', 'qa'],
    [`I=${S}/iris; cd $I && node perf.mjs 9810 http://127.0.0.1:3810/ $I/before-light.json light 2>&1 | tail -5`,
      'node perf.mjs 9810 http://127.0.0.1:3810/ $I/before-light.json light 2>&1 | tail -5', '$I'],
    // assignment then a real command
    [`SCR=${S}/e2e && mkdir -p $SCR/home $SCR/tmhome`, 'mkdir -p $SCR/home $SCR/tmhome', null],
    ['export NODE_ENV=test; npm run build', 'npm run build', null],
    ['export PATH="$HOME/bin:$PATH" && export FOO=1; cd ~/projects/x && make', 'make', 'x'],
    ['set -euo pipefail; cd /srv/app && ./deploy.sh', './deploy.sh', 'app'],
    ['source .venv/bin/activate && pytest -q', 'pytest -q', null],
    ['DEV_LOGIN=1 ADMIN_EMAILS=x@y.com npm start', 'npm start', null],
    ['env CI=1 npm test', 'npm test', null],
    ['GH_TOKEN=$(gh auth token -u Astandro) git push origin tm/x', 'git push origin tm/x', null],
    // quotes: a && inside quotes is not a separator
    ['cd /a && git commit -m "fix: a && b; c"', 'git commit -m "fix: a && b; c"', 'a'],
    ["cd /a && echo 'x; cd /b && y'", "echo 'x; cd /b && y'", 'a'],
    // quoted dir with spaces
    ['cd "/Users/a/My Projects/site" && ls', 'ls', 'site'],
    ["cd '/tmp/a b/' && ls -la", 'ls -la', 'a b'],
    ['cd ~ && ls', 'ls', '~'],
    ['cd && ls', 'ls', '~'],
    ['cd .. && npm ci', 'npm ci', '..'],
    // subshells
    ['cd /w/review-rebrand && (npx -y pnpm@10 test 2>&1 | grep -E "^# (tests|pass|fail)"); (npx -y pnpm@10 --dir extension test)',
      '(npx -y pnpm@10 test 2>&1 | grep -E "^# (tests|pass|fail)"); (npx -y pnpm@10 --dir extension test)', 'review-rebrand'],
    // || is a separator too
    ['cd /a || exit 1', 'exit 1', 'a'],
    // a bare cd is the action itself
    ['cd /Users/a/projects/x', 'cd /Users/a/projects/x', null],
    ['', '', null],
  ]
  for (const [cmd, action, dir] of cases) {
    it(JSON.stringify(cmd.slice(0, 70)), () => {
      assert.deepEqual(readableCommand(cmd), { action, dir })
    })
  }
})

describe('readableCommand: shell wrappers are opened', () => {
  it('bash -lc "…" with cd inside', () => {
    assert.deepEqual(readableCommand('bash -lc "cd /repo/app && npm test"'), { action: 'npm test', dir: 'app' })
  })
  it("sh -c '…'", () => {
    assert.deepEqual(readableCommand("sh -c 'npm run lint'"), { action: 'npm run lint', dir: null })
  })
  it('/bin/zsh -lc with escaped quotes inside', () => {
    assert.deepEqual(readableCommand('/bin/zsh -lc "cd /r && git commit -m \\"wip\\""'), { action: 'git commit -m "wip"', dir: 'r' })
  })
  it('cd outside the wrapper keeps that folder', () => {
    assert.deepEqual(readableCommand('cd /x/proj && bash -c "make test"'), { action: 'make test', dir: 'proj' })
  })
  it("single quotes closed and reopened ('\\'') are one script", () => {
    assert.deepEqual(readableCommand("bash -c 'echo '\\''hi'\\'' && ls'"), { action: "echo 'hi' && ls", dir: null })
  })
  it('a wrapper followed by more commands stays as written', () => {
    assert.equal(readableCommand('bash -c "a" && echo done').action, 'bash -c "a" && echo done')
  })
  it('bash running a script file is left alone', () => {
    assert.equal(readableCommand('bash scripts/run.sh --fast').action, 'bash scripts/run.sh --fast')
  })
})

describe('readableCommand: one line, heredoc bodies left out', () => {
  it('heredoc body is skipped, the rest of the command stays', () => {
    const cmd = "cd /a && python3 - <<'EOF'\nimport sys\nprint(sys.argv)\nEOF\necho done"
    assert.deepEqual(readableCommand(cmd), { action: "python3 - <<'EOF' echo done", dir: 'a' })
  })
  it('newlines inside quotes collapse to spaces', () => {
    assert.equal(readableCommand('cd /a && git commit -m "line one\n\nline two"').action, 'git commit -m "line one line two"')
  })
  it('backslash line continuation', () => {
    assert.equal(readableCommand('cd /a && docker run \\\n  --rm \\\n  img').action, 'docker run \\ --rm \\ img')
  })
})

describe('shortDir', () => {
  it('last path part, trailing slash and quotes removed', () => {
    assert.equal(shortDir('/Users/a/projects/my-app/'), 'my-app')
    assert.equal(shortDir('"/a/b c"'), 'b c')
    assert.equal(shortDir('~'), '~')
    assert.equal(shortDir('/'), '/')
    assert.equal(shortDir('$S/qa'), 'qa')
  })
})

describe('tool wiring', () => {
  it('only shell tools get the command treatment', () => {
    assert.equal(isCommandTool('Bash'), true)
    assert.equal(isCommandTool('exec_command'), true)
    assert.equal(isCommandTool('Read'), false)
    assert.equal(isCommandTool(undefined), false)
  })
  it('the full command (inputData) wins over the summarised args, which the extension cuts at 80 characters', () => {
    const full = 'cd /Users/example-developer-account/projects/team-monitor-wt/haze-commands && npx -y pnpm@10 test'
    const args = full.slice(0, 80)
    assert.equal(commandText(args, { command: full }), full)
    assert.deepEqual(toolArgsDisplay('Bash', args, { command: full }), { action: 'npx -y pnpm@10 test', dir: 'haze-commands' })
    assert.equal(commandText('ls -la', undefined), 'ls -la')
    assert.equal(commandText('ls', { command: '' }), 'ls')
  })
  it('other tools keep their args as they are (one line)', () => {
    assert.deepEqual(toolArgsDisplay('Read', 'web/lib/sky.ts'), { action: 'web/lib/sky.ts', dir: null })
    assert.deepEqual(toolArgsDisplay('Grep', 'cd && x'), { action: 'cd && x', dir: null })
  })
})

const chars = (s: string) => s.length

describe('middleTruncate: start and end kept, … between', () => {
  it('fits: unchanged', () => {
    assert.equal(middleTruncate('npm test', 20, chars), 'npm test')
  })
  it('too long: start and end both visible, within the width', () => {
    const t = 'git merge --no-ff revamp/s3-s4-docs'
    const out = middleTruncate(t, 20, chars)
    assert.ok(out.length <= 20, out)
    assert.ok(out.includes('…'), out)
    assert.ok(t.startsWith(out.split('…')[0]), out)
    assert.ok(t.endsWith(out.split('…')[1]), out)
    assert.equal(out, 'git merge --…s4-docs')
  })
  it('keeps as much as fits (one more character would not fit)', () => {
    for (const w of [5, 9, 14, 30]) {
      const t = 'node --import tsx --test "web/lib/**/*.test.ts" 2>&1 | tail -20'
      const out = middleTruncate(t, w, chars)
      assert.ok(out.length <= w)
      assert.ok(out.length >= w - 2, `${w}: ${out}`)
    }
  })
  it('nothing fits: just the ellipsis', () => {
    assert.equal(middleTruncate('abcdef', 1, chars), '…')
  })
  it('middleCut counts characters', () => {
    assert.equal(middleCut('abcdefghijklmnopqrstuvwxyz', 11), 'abcdef…wxyz')
  })
})

describe('fitLabelLine: the label stays whole, the action is cut in the middle', () => {
  it('fits', () => {
    assert.equal(fitLabelLine('Jalanin perintah', 'npm test', 40, chars), 'Jalanin perintah: npm test')
  })
  it('long command keeps the label, the start and the end of the action', () => {
    const out = fitLabelLine('Jalanin perintah', 'npx -y pnpm@10 --dir web exec tsc --noEmit', 40, chars)
    assert.ok(out.startsWith('Jalanin perintah: npx -y'), out)
    assert.ok(out.endsWith('--noEmit'), out)
    assert.ok(out.length <= 40, out)
  })
  it('no action: just the label', () => {
    assert.equal(fitLabelLine('Baca file', '', 40, chars), 'Baca file')
  })
  it('owner case: the card no longer reads "cd /Users/a…"', () => {
    const { action } = readableCommand('cd /Users/example-developer-account/projects/my-app && npm test')
    const out = fitLabelLine('Jalanin perintah', action, 31, chars)
    assert.equal(out, 'Jalanin perintah: npm test')
  })
})
