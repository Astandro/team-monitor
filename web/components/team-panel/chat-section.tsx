"use client"

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import { counterText, enterSends, MAX_MESSAGE_LENGTH, type ChatItem, type MessageResult } from '@/lib/team/chat'
import { BotAvatar } from '../bot-avatar'

type SendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string; until?: number }

export interface ChatSectionHandle {
  /** Bring the message box into view and focus it (the phone's floating button). */
  focus: () => void
}

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)')
    const on = (e: MediaQueryListEvent) => setCoarse(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return coarse
}

/**
 * Chat with the coordinator (spec-chat, D25): the thread, newest at the bottom, and a message box.
 * Messages are plain text (never HTML) with their line breaks. Status under the owner's messages comes from the
 * server only ("Terkirim" once written, "Dibaca <name>" once the coordinator recorded it).
 */
export const ChatSection = forwardRef<ChatSectionHandle, {
  thread: ChatItem[]
  coordinatorName: string
  watcherNotice: string
  send: (text: string) => Promise<MessageResult>
}>(function ChatSection({ thread, coordinatorName, watcherNotice, send }, ref) {
  const [text, setText] = useState('')
  const [state, setState] = useState<SendState>({ kind: 'idle' })
  const [, setTick] = useState(0)
  const boxId = useId()
  const hintId = useId()
  const listRef = useRef<HTMLOListElement>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const coarse = useCoarsePointer()

  useImperativeHandle(ref, () => ({
    focus: () => {
      sectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      boxRef.current?.focus({ preventScroll: true })
    },
  }))

  // newest at the bottom: follow new messages
  const lastId = thread.length > 0 ? thread[thread.length - 1].id : ''
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId, thread.length])

  // a 429 keeps the send button off until the server's wait is over
  const blockedUntil = state.kind === 'error' && state.until ? state.until : 0
  useEffect(() => {
    if (!blockedUntil) return
    const ms = blockedUntil - Date.now()
    if (ms <= 0) return
    const t = setTimeout(() => setTick((n) => n + 1), ms + 50)
    return () => clearTimeout(t)
  }, [blockedUntil])
  const blocked = blockedUntil > Date.now()

  const sending = state.kind === 'sending'
  const empty = !text.trim()
  const counter = counterText(text.length)

  async function go() {
    if (sending || blocked || empty) return
    setState({ kind: 'sending' })
    const r = await send(text)
    if (r.ok) {
      setText('')
      setState({ kind: 'sent' })
    } else {
      setState({
        kind: 'error',
        message: r.message,
        until: r.kind === 'limit' && r.retryAfter !== null ? Date.now() + r.retryAfter * 1000 : undefined,
      })
    }
  }

  return (
    <section className="tm-chat" id="chat" ref={sectionRef} aria-labelledby="tm-chat-title">
      <h2 id="tm-chat-title">Chat dengan {coordinatorName}</h2>
      <div className="tm-chat-card">
        {watcherNotice && (
          <div className="tm-chat-off" role="status">
            {watcherNotice}
          </div>
        )}
        {thread.length === 0 ? (
          <p className="tm-chat-empty">
            Belum ada pesan. Tulis di bawah, {coordinatorName} baca dan balas di sini selama sesinya jalan di Mac mini.
          </p>
        ) : (
          <ol className="tm-thread" ref={listRef} aria-label={`Percakapan dengan ${coordinatorName}`}>
            {thread.map((m) => (
              <li key={m.id} className={`tm-msg${m.mine ? ' mine' : ''}`}>
                <span className="sr-only">{m.who}: </span>
                <div className="tx">{m.text}</div>
                <div className="mt">
                  {!m.mine && (
                    <span className="who">
                      <BotAvatar name={m.who} coordinator size={18} className="tm-chat-av" />
                      {m.who}
                    </span>
                  )}
                  {m.time && <time>{m.time}</time>}
                  {m.status && <span className={`st${m.read ? ' read' : ''}`}>{m.status}</span>}
                </div>
              </li>
            ))}
          </ol>
        )}

        <form
          className="tm-compose"
          onSubmit={(e) => {
            e.preventDefault()
            void go()
          }}
        >
          <label htmlFor={boxId}>Pesan ke {coordinatorName}</label>
          <textarea
            id={boxId}
            ref={boxRef}
            value={text}
            rows={coarse ? 3 : 2}
            maxLength={MAX_MESSAGE_LENGTH}
            aria-describedby={hintId}
            placeholder="Tulis pesan…"
            onChange={(e) => {
              setText(e.target.value)
              if (state.kind === 'sent') setState({ kind: 'idle' })
            }}
            onKeyDown={(e) => {
              const k = { key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing }
              if (enterSends(k, coarse)) {
                e.preventDefault()
                void go()
              }
            }}
          />
          <div className="row">
            <span className="hint" id={hintId}>
              {coarse ? 'Maksimal 4000 huruf.' : 'Enter untuk kirim, Shift+Enter untuk baris baru.'}
              {counter && <span className={`count${text.length >= MAX_MESSAGE_LENGTH ? ' full' : ''}`}> {counter}</span>}
            </span>
            <button type="submit" className="tm-btn primary" disabled={sending || blocked || empty}>
              {sending ? 'Lagi ngirim…' : 'Kirim'}
            </button>
          </div>
          <div className="send-state" role="status" aria-live="polite">
            {state.kind === 'sending' && <span>Lagi ngirim pesan…</span>}
            {state.kind === 'sent' && <span>Terkirim. Statusnya ada di bawah pesanmu.</span>}
            {state.kind === 'error' && <span className="err">{state.message}</span>}
          </div>
        </form>
        <p className="tm-chat-limits">
          {coordinatorName} cuma bisa balas selama sesi Claude Code jalan di Mac mini. Kalau lagi di tengah langkah panjang,
          balasannya datang setelah langkah itu selesai.
        </p>
      </div>
    </section>
  )
})
