import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHAT_MIN_HEIGHT,
  chatOnScreen,
  chatPlacement,
  clampChatHeight,
  navTabs,
  paneForWidth,
  parseChatHeight,
  parseChatOpen,
  storeChatOpen,
} from './chat-layout'
import { graphPaneVisible } from '../frame-rate'

const components = join(__dirname, '..', '..', 'components', 'team-panel')

test('phone/tablet: chat is a tab, the third in the bottom bar; desktop: a panel, no bottom bar', () => {
  assert.equal(chatPlacement(false), 'tab')
  assert.equal(chatPlacement(true), 'panel')
  assert.deepEqual(navTabs(false), ['tim', 'grafik', 'chat'])
  assert.deepEqual(navTabs(true), [])
})

test('chat on screen: the Chat tab on a phone, the open panel on desktop, never in a background page', () => {
  const v = { desktop: false, pane: 'chat' as const, panelOpen: false, pageVisible: true }
  assert.equal(chatOnScreen(v), true)
  assert.equal(chatOnScreen({ ...v, pane: 'tim' }), false)
  assert.equal(chatOnScreen({ ...v, pane: 'grafik', panelOpen: true }), false, 'phone ignores the desktop flag')
  assert.equal(chatOnScreen({ ...v, desktop: true, pane: 'tim', panelOpen: true }), true)
  assert.equal(chatOnScreen({ ...v, desktop: true, pane: 'chat', panelOpen: false }), false)
  assert.equal(chatOnScreen({ ...v, pageVisible: false }), false)
})

test('the Chat tab hides the graph on a phone (it stops drawing), desktop keeps it', () => {
  assert.equal(graphPaneVisible('chat', false), false)
  assert.equal(graphPaneVisible('chat', true), true)
})

test('widening to desktop leaves the Chat tab for Tim; other panes stay', () => {
  assert.equal(paneForWidth('chat', true), 'tim')
  assert.equal(paneForWidth('chat', false), 'chat')
  assert.equal(paneForWidth('grafik', true), 'grafik')
})

test('open/closed is remembered; closed until opened once', () => {
  assert.equal(parseChatOpen(null), false)
  assert.equal(parseChatOpen(storeChatOpen(true)), true)
  assert.equal(parseChatOpen(storeChatOpen(false)), false)
})

test('panel height: full column until resized, then clamped between the minimum and the column', () => {
  assert.equal(clampChatHeight(null, 800), 800)
  assert.equal(clampChatHeight(500, 800), 500)
  assert.equal(clampChatHeight(100, 800), CHAT_MIN_HEIGHT)
  assert.equal(clampChatHeight(2000, 800), 800)
  assert.equal(clampChatHeight(500, 250), 250, 'a column shorter than the minimum gets the whole column')
  assert.equal(parseChatHeight('480'), 480)
  assert.equal(parseChatHeight('x'), null)
  assert.equal(parseChatHeight('-3'), null)
})

test('the Tim panel no longer holds the chat or the floating "Pesan ke" button', () => {
  const panel = readFileSync(join(components, 'team-panel.tsx'), 'utf8')
  assert.doesNotMatch(panel, /<ChatSection/)
  const app = readFileSync(join(components, 'team-app.tsx'), 'utf8')
  assert.doesNotMatch(app, /tm-fab/)
  assert.match(app, /<ChatSection/)
})

test('the shell clears unread only through chatOnScreen and keeps the desktop column out of the graph', () => {
  const app = readFileSync(join(components, 'team-app.tsx'), 'utf8')
  assert.match(app, /chatOnScreen\(\{ desktop, pane, panelOpen: chatOpen, pageVisible \}\)/)
  assert.match(app, /nextSeenMarks\(seen, model\.selectedId, model\.chat, chatVisible/)
  const css = readFileSync(join(components, 'team-panel.css'), 'utf8')
  // open: a third grid column (the graph keeps its area); closed: no column
  assert.match(css, /\[data-chat-open="true"\] \.tm-panes\{grid-template-columns:352px minmax\(0,1fr\) \d+px\}/)
  assert.match(css, /:not\(\[data-chat-open="true"\]\) \.tm-pane-chat\{display:none\}/)
  // the phone's hidden-pane rule (no animation, no taps) still covers the chat pane: it is a .tm-pane
  assert.match(app, /className="tm-pane tm-pane-chat/)
})
