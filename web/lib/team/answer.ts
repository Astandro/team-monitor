// Answering a decision: request, and plain-Indonesian mapping of every failure.

export const MAX_ANSWER_LENGTH = 2000

export type AnswerResult =
  | { ok: true; answeredAt?: string }
  | { ok: false; kind: 'login' | 'error'; status: number; message: string }

/** Minimal fetch shape so tests (and the fixture build) can inject a fake. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; credentials: 'same-origin'; body: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>

export function mapAnswerError(status: number, serverError?: string): { kind: 'login' | 'error'; message: string } {
  const detail = serverError && serverError.trim() ? serverError.trim() : ''
  switch (status) {
    case 401:
      return { kind: 'login', message: 'Sesi kamu habis. Masuk lagi dulu.' }
    case 403:
      return { kind: 'error', message: 'Server nolak jawaban ini. Muat ulang halaman lalu coba lagi.' }
    case 404:
      return { kind: 'error', message: 'Keputusan atau proyek ini sudah nggak ada di server.' }
    case 409:
      return { kind: 'error', message: 'Keputusan ini sudah dijawab' }
    case 429:
      return { kind: 'error', message: 'Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.' }
    case 0:
      return { kind: 'error', message: 'Nggak bisa nyambung ke server. Cek koneksi lalu coba lagi.' }
    case 400:
      return { kind: 'error', message: detail ? `Jawaban nggak diterima: ${detail}` : 'Jawaban nggak diterima.' }
    default:
      return {
        kind: 'error',
        message: detail ? `Gagal kirim jawaban: ${detail}` : `Gagal kirim jawaban (kode ${status}).`,
      }
  }
}

/** Trimmed answer, or null when it cannot be sent. */
export function cleanAnswer(raw: string): string | null {
  const text = raw.trim()
  if (!text || text.length > MAX_ANSWER_LENGTH) return null
  return text
}

export async function submitAnswer(
  fetchFn: FetchLike,
  project: string,
  id: string,
  answer: string,
): Promise<AnswerResult> {
  const text = cleanAnswer(answer)
  if (text === null) {
    return { ok: false, kind: 'error', status: 400, message: 'Jawaban kosong atau kepanjangan (maksimal 2000 huruf).' }
  }
  let res: { status: number; json: () => Promise<unknown> }
  try {
    res = await fetchFn('/api/team/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Team-Monitor': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({ project, id, answer: text }),
    })
  } catch {
    return { ok: false, ...mapAnswerError(0), status: 0 }
  }
  let body: { ok?: boolean; error?: string; answeredAt?: string } = {}
  try {
    body = ((await res.json()) ?? {}) as typeof body
  } catch {
    body = {}
  }
  if (res.status >= 200 && res.status < 300 && body.ok !== false) {
    return { ok: true, answeredAt: body.answeredAt }
  }
  return { ok: false, status: res.status, ...mapAnswerError(res.status, body.error) }
}
