import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrapText } from './wrap-text'

// 1 unit per character keeps the arithmetic obvious.
const measure = (s: string) => s.length

const squash = (s: string) => s.replace(/\s+/g, '')

test('short text stays on one line', () => {
  assert.deepEqual(wrapText('halo dunia', 20, measure), ['halo dunia'])
})

test('wraps at word boundaries and loses no word', () => {
  const text = 'Perbaiki label grafik supaya mudah dibaca dan judul tampil penuh'
  const lines = wrapText(text, 16, measure)
  assert.ok(lines.length > 1)
  assert.equal(lines.join(' '), text)
  for (const l of lines) assert.ok(measure(l) <= 16, `"${l}" too wide`)
})

test('a word longer than the width is broken, not dropped', () => {
  const lines = wrapText('ab supercalifragilistic cd', 6, measure)
  for (const l of lines) assert.ok(measure(l) <= 6, `"${l}" too wide`)
  assert.equal(squash(lines.join('')), 'absupercalifragilisticcd')
  assert.ok(lines.some(l => l.startsWith('super')))
})

test('very long single token spreads across many lines with every character kept', () => {
  const token = 'x'.repeat(50)
  const lines = wrapText(token, 8, measure)
  assert.equal(lines.length, Math.ceil(50 / 8))
  assert.equal(lines.join(''), token)
})

test('does not loop forever when not even one character fits', () => {
  const lines = wrapText('abc', 0, measure)
  assert.equal(lines.join(''), 'abc')
})

test('keeps explicit newlines and collapses extra spaces', () => {
  assert.deepEqual(wrapText('satu   dua\ntiga', 20, measure), ['satu dua', 'tiga'])
})

test('empty text yields one empty line so callers can always draw', () => {
  assert.deepEqual(wrapText('', 10, measure), [''])
})

test('uses the measure callback, not the character count', () => {
  const wide = (s: string) => s.length * 3
  const lines = wrapText('aa bb cc', 7, wide)
  assert.deepEqual(lines, ['aa', 'bb', 'cc'])
})
