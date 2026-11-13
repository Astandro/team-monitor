/**
 * Message text without the Markdown marks a chat reply carries (owner feedback 13 Nov: "**" must never show raw).
 * Keeps the words, drops the marks: **bold**, __bold__, *em*, _em_, `code`, # headings, > quotes, list bullets,
 * [label](url) links. Stray marks that do not form a pair stay (a glob like `src/**` loses only its backticks).
 */
export function plainText(md: string): string {
  return md
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^(\s*)[-*+]\s+(?=\S)/, '$1')
        .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, '$1')
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
        .replace(/__(?=\S)(.+?)(?<=\S)__/g, '$1')
        .replace(/(^|[\s(])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?=$|[\s.,;:!?)])/g, '$1$2')
        .replace(/(^|[\s(])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?=$|[\s.,;:!?)])/g, '$1$2')
        .replace(/`([^`\n]+)`/g, '$1'),
    )
    .join('\n')
}

/** One line for a collapsed preview: plain text, whitespace folded. */
export function previewLine(md: string): string {
  return plainText(md).replace(/\s+/g, ' ').trim()
}
