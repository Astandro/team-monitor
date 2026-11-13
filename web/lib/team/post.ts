// One POST helper for the panel's and the graph's write requests (chat message, offboard), same headers and
// credentials as the answer POST. Pure apart from the injected fetch, so tests pass a fake.

export interface PostResponse {
  status: number
  json: () => Promise<unknown>
  headers?: { get: (name: string) => string | null }
}

export type PostFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; credentials: 'same-origin'; body: string },
) => Promise<PostResponse>

export type PostOutcome =
  /** status 0: the request never reached the server */
  | { status: number; body: Record<string, unknown>; retryAfter: number | null }

/** Seconds from a Retry-After header (seconds form only); null when missing or unreadable. */
export function parseRetryAfter(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || !/^\s*\d+\s*$/.test(raw)) return null
  return Number(raw.trim())
}

export async function postTeam(fetchFn: PostFetch, url: string, payload: unknown): Promise<PostOutcome> {
  let res: PostResponse
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Team-Monitor': '1' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    })
  } catch {
    return { status: 0, body: {}, retryAfter: null }
  }
  let body: Record<string, unknown> = {}
  try {
    const parsed = await res.json()
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
  } catch {
    body = {}
  }
  return { status: res.status, body, retryAfter: parseRetryAfter(res.headers?.get('Retry-After')) }
}

export function serverError(body: Record<string, unknown>): string {
  return typeof body.error === 'string' ? body.error.trim() : ''
}

export function isOk(o: PostOutcome): boolean {
  return o.status >= 200 && o.status < 300 && o.body.ok !== false
}
