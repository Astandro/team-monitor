/**
 * Dev entry for the coordinator wait command (no bundle needed):
 *   node --import tsx app/src/team/wait-answer-main.ts --project <path> [--timeout <s>]
 * The built app runs the same code as `node app/dist/app.js wait-answer ...`.
 */
import { runWaitAnswerCli } from './wait-answer'

runWaitAnswerCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => { console.error(e); process.exit(2) },
)
