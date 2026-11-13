/**
 * Instance names (owner decisions D22/D23): the coordinator names every spawned
 * instance in the Agent `description`, as "<Name> (<role>): <task>", e.g.
 * "Hiro (Frontend Engineer): Offboard button on the graph". The graph keeps the
 * full description as the node's identity (`name`); the parts are added to the
 * spawn payload so the UI can show "Hiro · Frontend Engineer".
 */

export interface InstanceName {
  /** Personal name, e.g. "Hiro". */
  displayName: string
  /** Standard role, e.g. "Frontend Engineer". */
  role: string
  /** What the instance was asked to do; '' when the description stops after the colon. */
  task: string
}

export const INSTANCE_NAME_MAX = 40
export const INSTANCE_ROLE_MAX = 60

/**
 * Name: one word that starts with an upper-case (or caseless, e.g. kana) letter, then letters, marks, apostrophes
 * or hyphens ("Daichi", "Ren", "O'Hara", "Jean-Luc"). Role: no parentheses, at least one letter. Then a colon.
 * Anything else (no role, nested parentheses, a lower-case first word, a sentence before the parenthesis) is not an
 * instance name, and the caller keeps its current behaviour.
 */
const INSTANCE_RE = /^\s*([\p{Lu}\p{Lo}][\p{L}\p{M}'’-]*)\s*\(([^()]*)\)\s*:\s*([\s\S]*)$/u

export function parseInstanceName(description: unknown): InstanceName | null {
  if (typeof description !== 'string') return null
  const m = INSTANCE_RE.exec(description)
  if (!m) return null
  const displayName = m[1]
  const role = m[2].replace(/\s+/g, ' ').trim()
  if (displayName.length > INSTANCE_NAME_MAX) return null
  if (!role || role.length > INSTANCE_ROLE_MAX || !/\p{L}/u.test(role)) return null
  return { displayName, role, task: m[3].trim() }
}
