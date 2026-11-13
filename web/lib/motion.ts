/**
 * The page's motion setting comes from the OS only (owner request 13 Nov: no "Jeda animasi" button).
 * `reducedMotion()` is cheap enough to call every frame: one MediaQueryList, read live.
 */
let mq: MediaQueryList | null | undefined

export function reducedMotion(): boolean {
  if (mq === undefined) {
    mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
  }
  return mq ? mq.matches : false
}
