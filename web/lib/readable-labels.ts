/**
 * Plain Indonesian labels for things the graph shows to a reader.
 *
 * Rule (owner request O2): a viewer never reads a raw tool code such as
 * "Bash" or "mcp__claude_ai_Gmail__search_threads". The original name stays
 * available in the detail popup for whoever needs it.
 */

const TOOL_LABELS: Record<string, string> = {
  Bash: 'Jalanin perintah',
  BashOutput: 'Lihat hasil perintah',
  KillShell: 'Hentikan perintah',
  Read: 'Baca file',
  Write: 'Tulis file',
  Edit: 'Ubah file',
  MultiEdit: 'Ubah file (banyak bagian)',
  Grep: 'Cari isi file',
  Glob: 'Cari nama file',
  LS: 'Lihat isi folder',
  Agent: 'Kirim agent',
  Task: 'Kirim agent',
  TaskStop: 'Hentikan tugas',
  TaskOutput: 'Lihat hasil tugas',
  WebFetch: 'Buka halaman web',
  WebSearch: 'Cari di web',
  TodoWrite: 'Catat daftar tugas',
  NotebookEdit: 'Ubah notebook',
  Skill: 'Pakai skill',
  ToolSearch: 'Cari alat',
  SendMessage: 'Kirim pesan',
  Monitor: 'Pantau proses',
  AskUserQuestion: 'Tanya pengguna',
  EnterPlanMode: 'Mulai menyusun rencana',
  ExitPlanMode: 'Selesai menyusun rencana',
  EnterWorktree: 'Masuk worktree',
  ExitWorktree: 'Keluar worktree',
  // Codex runtime
  exec_command: 'Jalanin perintah',
  write_stdin: 'Kirim input ke perintah',
  update_plan: 'Perbarui rencana',
  apply_patch: 'Terapkan perubahan',
}

const MCP_PREFIX = 'mcp__'

function spaced(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Short plain label for a tool name. Never returns an empty string or a raw code. */
export function toolLabel(toolName: string | undefined | null): string {
  const name = (toolName ?? '').trim()
  if (!name) return 'Alat'

  const known = TOOL_LABELS[name]
  if (known) return known

  if (name.startsWith(MCP_PREFIX)) {
    const parts = name.slice(MCP_PREFIX.length).split('__').filter(Boolean)
    const server = spaced(parts[0] ?? '')
    const tool = spaced(parts.slice(1).join(' '))
    if (server && tool) return `Alat ${server}: ${tool}`
    if (server) return `Alat ${server}`
    return 'Alat tambahan'
  }

  const words = spaced(name)
  if (!words) return 'Alat'
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

/** True when the plain label differs from the original name (so the popup should also show the original). */
export function hasDistinctToolName(toolName: string | undefined | null): boolean {
  return (toolName ?? '').trim() !== '' && toolLabel(toolName) !== toolName
}

const STATE_LABELS: Record<string, string> = {
  idle: 'Diam',
  thinking: 'Berpikir',
  tool_calling: 'Memakai alat',
  complete: 'Selesai',
  error: 'Gagal',
  paused: 'Dijeda',
  waiting_permission: 'Menunggu izin',
}

/** Plain label for an agent or tool state. */
export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? spaced(state)
}

const TOOL_STATE_LABELS: Record<string, string> = {
  running: 'Berjalan',
  complete: 'Selesai',
  error: 'Gagal',
}

export function toolStateLabel(state: string): string {
  return TOOL_STATE_LABELS[state] ?? stateLabel(state)
}

/** "Baca file: src/a.ts" style line for a tool call. Args are optional. */
export function toolCallLine(toolName: string, args?: string): string {
  const label = toolLabel(toolName)
  return args ? `${label}: ${args}` : label
}
