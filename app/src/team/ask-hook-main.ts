/**
 * Entry of the Claude Code AskUserQuestion hook (bundled to app/dist/ask-hook.js).
 * Reads the hook JSON from stdin, prints nothing or one PreToolUse decision, and
 * always exits 0. See ask-hook.ts and docs/coordinator.md.
 *
 * Dev: node --import tsx app/src/team/ask-hook-main.ts < hook-input.json
 */
import * as fs from 'fs'
import * as path from 'path'
import { MAX_HOOK_INPUT_BYTES, runAskHook } from './ask-hook'

const STDIN_TIMEOUT_MS = 5000

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf-8'))
    }
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS)
    process.stdin.on('data', (c: Buffer) => {
      size += c.length
      // Keep one byte over the cap so runAskHook sees it is too large.
      if (size <= MAX_HOOK_INPUT_BYTES + 1) chunks.push(c)
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
  })
}

function waitCommand(): string | undefined {
  // Bundled: this file is app/dist/ask-hook.js and the CLI is app/dist/app.js next to it.
  const app = path.join(__dirname, 'app.js')
  return fs.existsSync(app) ? `node "${app}" wait-answer` : undefined
}

readStdin()
  .then((text) => {
    const r = runAskHook(text, { waitCommand: waitCommand() })
    // Pipes can be asynchronous on macOS: exit only once the decision is flushed.
    if (r.stdout) process.stdout.write(r.stdout, () => process.exit(0))
    else process.exit(0)
  })
  .catch(() => process.exit(0))
