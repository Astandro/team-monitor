// Dev-only sample data for looking at the panel without a server. It is only reachable from a build made with
// TM_FIXTURE=1 (see web/vite.config.app.ts); a normal build replaces the guard with a constant and drops this file.
import type { FetchLike } from '../answer'
import type { TeamProject, TeamState } from '../types'

export const FIXTURE_PROJECTS: TeamProject[] = [
  { id: 'revamp-ui', name: 'Revamp UI My App', hasState: true },
  { id: 'catatan-pribadi', name: 'Catatan pribadi', hasState: true },
  { id: 'proyek-kosong', name: 'Proyek yang belum punya data', hasState: false },
]

const LONG_TITLE =
  'Merombak seluruh halaman Explore supaya filter kategori, urutan kartu proyek, dan tampilan kosongnya tetap enak dibaca di layar HP yang sempit tanpa ada judul yang terpotong'

export function makeFixtureState(projectId: string, now: number): TeamState {
  const ago = (min: number) => new Date(now - min * 60_000).toISOString()
  if (projectId === 'catatan-pribadi') {
    return {
      meta: { title: 'Catatan pribadi', statusText: 'Satu tahap lagi, tinggal dirapikan', status: 'running' },
      stages: { s1: { kind: 'stage', label: 'Kumpulin bahan', sub: 'Semua catatan lama', order: 1, status: 'done', progress: 1 } },
      tasks: { t1: { title: 'Pindahin catatan lama', stage: 's1', order: 1, status: 'done', agent: 'a1' } },
      agents: { a1: { nick: 'Sora', name: 'Software Architect', model: 'Opus 5.5', desk: 'coordinator', status: 'idle', reportsTo: 'you', order: 1 } },
      approvals: {},
      log: { e1: { t: ago(180), kind: 'handoff', text: 'Catatan lama sudah dipindah semua.' } },
    }
  }
  return {
    meta: {
      title: `Monitor Revamp UI My App: ${LONG_TITLE}`,
      statusText: 'Lagi jalan, 2 dikerjain, 1 nunggu review, 1 butuh keputusan kamu',
      status: 'running',
      updatedAt: ago(0),
    },
    stages: {
      st1: { kind: 'stage', label: 'Fondasi dan token desain', sub: 'Warna, huruf, jarak', order: 1, status: 'done', progress: 1 },
      st2: { kind: 'gate', label: 'Gerbang review desain', sub: 'Dicek Mei sebelum lanjut', order: 2, status: 'done', progress: 1 },
      st3: { kind: 'stage', label: 'Halaman Explore dan detail proyek', sub: 'Tampilan HP dulu', order: 3, status: 'active', progress: 0.45 },
      st4: { kind: 'stage', label: 'Halaman admin', sub: 'Setelah Explore selesai', order: 4, status: 'todo', progress: 0 },
    },
    tasks: {
      tm01: { title: 'Token warna terang dan gelap', stage: 'st1', order: 1, status: 'done', note: 'Kontras sudah dicek', agent: 'a3' },
      tm02: { title: 'Komponen kartu proyek', stage: 'st1', order: 2, status: 'done', agent: 'a3' },
      tm03: { title: LONG_TITLE, stage: 'st3', order: 3, status: 'running', note: 'Lagi nyocokin lebar kartu di 390 px dan 768 px', agent: 'a2' },
      tm04: { title: 'Halaman detail proyek', stage: 'st3', order: 4, status: 'running', note: 'Tinggal bagian galeri', agent: 'a4' },
      tm05: { title: 'Filter kategori di Explore', stage: 'st3', order: 5, status: 'review', note: 'Nunggu Mei', agent: 'a2' },
      tm06: { title: 'Upload gambar sampul', stage: 'st3', order: 6, status: 'blocked', note: 'Nunggu keputusan ukuran maksimal file', agent: 'a4' },
      tm07: { title: 'Tabel pengguna di admin', stage: 'st4', order: 7, status: 'todo' },
      tm08: { title: 'Pengaturan peran dan izin', stage: 'st4', order: 8, status: 'todo', agent: 'a5' },
    },
    agents: {
      a1: { nick: 'Sora', name: 'Software Architect', model: 'Opus 5.5', desk: 'coordinator', status: 'working', task: 'Ngatur urutan kerja tahap Explore', reportsTo: 'you', order: 1 },
      a2: { nick: 'Yuki', name: 'Software Engineer', model: 'Sonnet 5.5', desk: 'builder', status: 'working', task: 'tm03', reportsTo: 'a1', order: 2 },
      a3: { nick: 'Aoi', name: 'Software Engineer', model: 'Sonnet 5.5', desk: 'builder', status: 'idle', reportsTo: 'a1', order: 3 },
      a4: { nick: 'Kaito', name: 'Senior Engineer', model: 'Opus 5.5', desk: 'builder', status: 'working', task: 'Nyiapin halaman detail proyek lengkap dengan galeri gambar dan tombol bagikan', reportsTo: 'a1', order: 4 },
      a5: { nick: 'Mei', name: 'Code Reviewer', model: 'Opus 5.5', desk: 'reviewer', status: 'working', task: 'Review filter kategori', reportsTo: 'a1', order: 5 },
      a6: { nick: 'Rin', name: 'Quality Grader', model: 'Sonnet 5.5', desk: 'grader', status: 'idle', reportsTo: 'a1', order: 6 },
      a7: { nick: 'Hana', name: 'Software Engineer', model: 'Sonnet 5.5', desk: 'builder', status: 'idle', reportsTo: 'a1', order: 7 },
    },
    approvals: {
      D1: {
        title: 'Ukuran maksimal gambar sampul proyek yang boleh diunggah pengguna',
        question: 'Mau dibatasi berapa MB? Batas kecil bikin unggahan cepat tapi gambar bisa kelihatan pecah di layar besar.',
        options: ['2 MB', '5 MB', '10 MB'],
        recommended: '5 MB',
        status: 'open',
        askedAt: ago(12),
        order: 1,
      },
      D2: {
        title: 'Judul halaman Explore',
        question: 'Pakai "Jelajah" atau tetap "Explore"?',
        options: ['Jelajah', 'Explore'],
        recommended: 'Explore',
        status: 'open',
        askedAt: ago(30),
        order: 2,
      },
      D3: {
        title: 'Warna aksen utama',
        question: 'Hijau tua atau biru laut?',
        options: ['Hijau tua', 'Biru laut'],
        recommended: 'Hijau tua',
        answer: 'Hijau tua',
        status: 'answered',
        askedAt: ago(300),
        answeredAt: ago(280),
        order: 3,
      },
    },
    log: {
      e001: { t: ago(1), from: 'a2', to: 'a1', kind: 'handoff', text: 'Yuki selesai nyocokin kartu proyek di 390 px, lanjut ke 768 px.' },
      e002: { t: ago(14), from: 'a1', to: 'a5', kind: 'review', text: 'Sora minta Mei review filter kategori.' },
      e003: { t: ago(95), kind: 'decision', text: 'Kamu milih hijau tua sebagai warna aksen.' },
      e004: { t: ago(60 * 30), kind: 'assign', text: 'Sora bagi tugas tahap Explore ke tiga engineer.' },
    },
  }
}

/** Pretends to be POST /api/team/answer. An answer containing "error" fails with 500, "dobel" with 409. */
export function makeFixtureFetch(): FetchLike {
  return async (_url, init) => {
    await new Promise((r) => setTimeout(r, 700))
    const body = JSON.parse(init.body) as { answer: string }
    if (/error/i.test(body.answer)) return { status: 500, json: async () => ({ ok: false, error: 'disk penuh' }) }
    if (/dobel/i.test(body.answer)) return { status: 409, json: async () => ({ ok: false, error: 'decision not open' }) }
    return { status: 200, json: async () => ({ ok: true, answeredAt: new Date().toISOString() }) }
  }
}
