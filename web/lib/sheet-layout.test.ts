import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSheetLayout, nextSheetView, SHEET, sheetMaxHeight } from './sheet-layout'

test('phones and tablets get the sheet, desktop keeps the floating card', () => {
  assert.equal(isSheetLayout(390), true)
  assert.equal(isSheetLayout(768), true)
  assert.equal(isSheetLayout(1023), true)
  assert.equal(isSheetLayout(1024), false)
  assert.equal(isSheetLayout(1440), false)
  assert.equal(isSheetLayout(0), false)
})

test('the sheet takes at most 70% of the graph and never reaches the top controls or the play bar', () => {
  // 390 x 844 phone, graph pane about 760 tall, one control row of 64
  const h = sheetMaxHeight(760, 64)
  assert.ok(h <= 760 * 0.7, `${h}`)
  assert.ok(h + SHEET.bottom + SHEET.gapTop + 64 <= 760)
  // a short pane: the free band wins over 70%
  const short = sheetMaxHeight(500, 120)
  assert.equal(short, 500 - 120 - SHEET.gapTop - SHEET.bottom)
  // 768 tablet with two bar rows: 70% wins
  assert.equal(sheetMaxHeight(960, 140), Math.floor(960 * 0.7))
})

test('the sheet keeps a usable height on a tiny screen (it scrolls inside)', () => {
  assert.equal(sheetMaxHeight(300, 200), SHEET.minHeight)
})

test('detail first, transcript one tap away, back returns, a new agent starts at its detail', () => {
  assert.equal(nextSheetView('detail', 'open-transcript'), 'transcript')
  assert.equal(nextSheetView('transcript', 'back'), 'detail')
  assert.equal(nextSheetView('transcript', 'agent-changed'), 'detail')
})
