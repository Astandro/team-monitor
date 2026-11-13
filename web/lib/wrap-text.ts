/**
 * Word wrap for canvas text (owner request O3: titles are always shown in full).
 *
 * Pure: takes a measure callback so it can be tested without a canvas.
 * - Existing newlines start a new line.
 * - Words are packed greedily; whitespace between words is collapsed to one space.
 * - A single word wider than maxWidth is broken into pieces, never dropped.
 * - Every returned line is within maxWidth, except when even one character
 *   does not fit (then that character is kept alone on its line).
 */
export type MeasureFn = (text: string) => number

function breakLongWord(word: string, maxWidth: number, measure: MeasureFn): string[] {
  const pieces: string[] = []
  let rest = word
  while (rest.length > 0) {
    if (measure(rest) <= maxWidth) {
      pieces.push(rest)
      break
    }
    // Largest prefix that fits, at least one character so we always progress.
    let lo = 1
    let hi = rest.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (measure(rest.slice(0, mid)) <= maxWidth) lo = mid
      else hi = mid - 1
    }
    pieces.push(rest.slice(0, lo))
    rest = rest.slice(lo)
  }
  return pieces
}

export function wrapText(text: string, maxWidth: number, measure: MeasureFn): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      if (text.includes('\n')) lines.push('')
      continue
    }
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (measure(candidate) <= maxWidth) {
        current = candidate
        continue
      }
      if (current) lines.push(current)
      if (measure(word) <= maxWidth) {
        current = word
      } else {
        const pieces = breakLongWord(word, maxWidth, measure)
        lines.push(...pieces.slice(0, -1))
        current = pieces[pieces.length - 1]
      }
    }
    if (current) lines.push(current)
  }
  return lines.length > 0 ? lines : ['']
}
