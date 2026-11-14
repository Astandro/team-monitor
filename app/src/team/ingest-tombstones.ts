/**
 * Key bindings of evicted cloud sources (hub intake, NEW-2). When the hub removes a source (source cap, or 24 hours
 * silent) its mirror goes, and with it `source.json`, which held the sha256 of the source key bound to the sourceId.
 * The binding is kept here instead, so a later request for that sourceId with another key is still refused (403),
 * and the real key is accepted again (its source is created anew).
 *
 * - File `<team home>/ingest-tombstones.json`, 0600, written atomically after every change.
 * - An entry expires 30 days after the eviction. At most 10,000 entries: beyond that the oldest are dropped, and
 *   their sourceIds are unbound again (the next request binds whatever key it carries, like a new sourceId).
 * - Only hashes are stored, never keys. The file is read with a size cap and checked entry by entry; a damaged file
 *   is ignored (logged) and replaced at the next change.
 */
import * as fs from 'fs'
import { writeFileAtomic } from './service'

export const TOMBSTONE_FILE = 'ingest-tombstones.json'
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_TOMBSTONES = 10_000
const MAX_FILE_BYTES = 4 * 1024 * 1024
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const KEY_HASH_RE = /^[0-9a-f]{64}$/

interface Tombstone { keyHash: string; evictedAt: number }

export interface TombstoneOptions {
  file: string
  now: () => number
  log: (msg: string) => void
  ttlMs?: number
  max?: number
}

export class TombstoneStore {
  readonly file: string
  private readonly now: () => number
  private readonly log: (msg: string) => void
  private readonly ttlMs: number
  private readonly max: number
  /** sourceId -> binding, oldest eviction first. */
  private entries = new Map<string, Tombstone>()
  private dirty = false

  constructor(opts: TombstoneOptions) {
    this.file = opts.file
    this.now = opts.now
    this.log = opts.log
    this.ttlMs = opts.ttlMs ?? TOMBSTONE_TTL_MS
    this.max = opts.max ?? MAX_TOMBSTONES
  }

  /** Read the file (missing: empty). Expired entries are left out; beyond the cap the oldest are. */
  load(): void {
    this.entries.clear()
    let text: string | null = null
    let fd: number | null = null
    try {
      const st = fs.lstatSync(this.file)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error('not a plain file of at most 4 MB')
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      text = fs.readFileSync(fd, 'utf-8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`[ingest] ${this.file} ignored: ${(e as Error).message}`)
    } finally {
      if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
    }
    if (text === null) return
    let list: unknown
    try { list = (JSON.parse(text) as { tombstones?: unknown }).tombstones } catch { list = null }
    if (!Array.isArray(list)) {
      this.log(`[ingest] ${this.file} ignored: not a tombstone list`)
      return
    }
    const now = this.now()
    const ok: Array<[string, Tombstone]> = []
    for (const t of list as Array<Record<string, unknown>>) {
      if (!t || typeof t !== 'object') continue
      const evictedAt = typeof t.evictedAt === 'string' ? Date.parse(t.evictedAt) : NaN
      if (typeof t.sourceId !== 'string' || !SOURCE_ID_RE.test(t.sourceId)) continue
      if (typeof t.keyHash !== 'string' || !KEY_HASH_RE.test(t.keyHash)) continue
      if (!Number.isFinite(evictedAt) || now - evictedAt >= this.ttlMs) { this.dirty = true; continue }
      ok.push([t.sourceId, { keyHash: t.keyHash, evictedAt }])
    }
    ok.sort((a, b) => a[1].evictedAt - b[1].evictedAt)
    for (const [id, t] of ok) { this.entries.delete(id); this.entries.set(id, t) }
    this.trim()
  }

  /** The key hash bound to an evicted `sourceId`, or null (none, or expired). */
  get(sourceId: string): string | null {
    const t = this.entries.get(sourceId)
    if (!t) return null
    if (this.now() - t.evictedAt >= this.ttlMs) {
      this.entries.delete(sourceId)
      this.dirty = true
      return null
    }
    return t.keyHash
  }

  /** Keep the binding of a source being evicted now. Saved by flush(). */
  add(sourceId: string, keyHash: string): void {
    this.entries.delete(sourceId)
    this.entries.set(sourceId, { keyHash, evictedAt: this.now() })
    this.dirty = true
    this.trim()
  }

  /** The source is back (its own source.json holds the binding again). Saved by flush(). */
  remove(sourceId: string): void {
    if (this.entries.delete(sourceId)) this.dirty = true
  }

  /** Write the file if anything changed. False when the write failed (kept in memory; tried again next time). */
  flush(): boolean {
    if (!this.dirty) return true
    const now = this.now()
    for (const [id, t] of this.entries) if (now - t.evictedAt >= this.ttlMs) this.entries.delete(id)
    const tombstones = [...this.entries].map(([sourceId, t]) => ({ sourceId, keyHash: t.keyHash, evictedAt: new Date(t.evictedAt).toISOString() }))
    try {
      writeFileAtomic(this.file, JSON.stringify({ v: 1, tombstones }) + '\n', 0o600)
      this.dirty = false
      return true
    } catch (e) {
      this.log(`[ingest] cannot write ${this.file}: ${(e as Error).message}`)
      return false
    }
  }

  size(): number {
    return this.entries.size
  }

  /** Beyond the cap: drop the oldest. */
  private trim(): void {
    for (const id of this.entries.keys()) {
      if (this.entries.size <= this.max) break
      this.entries.delete(id)
      this.dirty = true
    }
  }
}
