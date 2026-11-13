import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plainText, previewLine } from './plain-text'

test('bold, italics and code marks go, the words stay', () => {
  assert.equal(plainText('**Grafik di HP kekecilan.** Zoom awal'), 'Grafik di HP kekecilan. Zoom awal')
  assert.equal(plainText('__penting__ dan *miring* dan _juga_'), 'penting dan miring dan juga')
  assert.equal(plainText('jalanin `pnpm test` dulu'), 'jalanin pnpm test dulu')
})

test('headings, quotes, bullets and links read as plain lines', () => {
  assert.equal(plainText('## Ringkasan\n> catatan\n- satu\n* dua\n  + tiga'), 'Ringkasan\ncatatan\nsatu\ndua\n  tiga')
  assert.equal(plainText('lihat [handover](docs/handover.md) ya'), 'lihat handover ya')
})

test('stray marks that are not Markdown stay as written', () => {
  assert.equal(plainText('glob web/lib/**/*.test.ts'), 'glob web/lib/**/*.test.ts')
  assert.equal(plainText('3 * 4 = 12'), '3 * 4 = 12')
  assert.equal(plainText('snake_case_name'), 'snake_case_name')
})

test('the collapsed preview is one line with no asterisks', () => {
  const p = previewLine('Pesan kamu soal tampilan grafik.\n\n**Grafik di HP kekecilan.** Zoom awal bakal pas.')
  assert.equal(p, 'Pesan kamu soal tampilan grafik. Grafik di HP kekecilan. Zoom awal bakal pas.')
  assert.ok(!p.includes('*'))
})
