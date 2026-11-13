"use client"

import { useEffect, useId, useRef, useState } from 'react'
import { MAX_ANSWER_LENGTH, type AnswerResult } from '@/lib/team/answer'
import { OWNER_LABEL } from '@/lib/team/labels'
import { newBubbleKeys, themeButton, type ThemePref } from '@/lib/team/session'
import type { DecisionVM, MemberVM, TaskVM } from '@/lib/team/view-model'
import type { TeamModel } from './use-team-model'
import { ChatSection, type ChatSectionHandle } from './chat-section'

interface PanelProps {
  model: TeamModel
  theme: ThemePref
  onCycleTheme: () => void
  chatRef?: React.Ref<ChatSectionHandle>
}

function Avatar({ tone, initial, working, size }: { tone: string; initial: string; working?: boolean; size?: 'lead' }) {
  return (
    <div className={`tm-av ${tone}${working ? ' working' : ''}${size === 'lead' ? ' big' : ''}`} aria-hidden="true">
      {initial}
      {working !== undefined && <span className={`st ${working ? 'work' : 'idle'}`} />}
    </div>
  )
}

function Member({ m, lead }: { m: MemberVM; lead?: boolean }) {
  return (
    <div className="tm-member">
      <Avatar tone={m.tone} initial={m.initial} working={m.working} size={lead ? 'lead' : undefined} />
      <div className="nm">{m.nick}</div>
      {m.role && <div className="rl">{m.role}</div>}
      {m.model && <div className="rl mdl">{m.model}</div>}
      <div className={`tk${m.working && m.task ? '' : ' idle'}`}>
        <span className="sr-only">{m.working ? 'Lagi ngerjain: ' : 'Status: '}</span>
        {m.working && m.task ? m.task : 'Siaga'}
      </div>
    </div>
  )
}

function Bubble({ t, fresh }: { t: TaskVM; fresh: boolean }) {
  return (
    <div className={`tm-bubble${t.status === 'running' ? ' running' : ''}${fresh ? ' enter' : ''}`}>
      <Avatar tone={t.tone} initial={t.initial} />
      <div className="bd">
        <div className="tt">{t.title}</div>
        <div className="meta">
          <span className={`tm-chip ${t.status}`}>{t.statusLabel}</span>
          {t.who && <span> {t.who}</span>}
        </div>
        {t.note && <div className="nt">{t.note}</div>}
      </div>
    </div>
  )
}

type SendState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'error'; message: string }

function Decision({
  d,
  send,
}: {
  d: DecisionVM
  send: (id: string, answer: string) => Promise<AnswerResult>
}) {
  const [text, setText] = useState('')
  const [state, setState] = useState<SendState>({ kind: 'idle' })
  const inputId = useId()
  const sending = state.kind === 'sending'

  async function go(answer: string) {
    if (sending || !answer.trim()) return
    setState({ kind: 'sending' })
    const r = await send(d.id, answer)
    if (r.ok) setState({ kind: 'idle' })
    else setState({ kind: 'error', message: r.message })
  }

  if (!d.open) {
    return (
      <div className="tm-dec answered">
        <h3>{d.title}</h3>
        {d.question && <p>{d.question}</p>}
        <div className="done-line" role="status">
          {d.answer ? (
            <>
              Jawaban: <strong>{d.answer}</strong>
            </>
          ) : (
            <strong>Sudah dijawab</strong>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="tm-dec">
      <h3>{d.title}</h3>
      {d.question && <p>{d.question}</p>}
      {d.options.length > 0 && (
        <div className="opts">
          {d.options.map((o, i) => (
            <button key={i} type="button" className="opt" disabled={sending} onClick={() => void go(o.label)}>
              <span>{o.label}</span>
              {o.recommended && <span className="rec">{d.recommendedBy}</span>}
            </button>
          ))}
        </div>
      )}
      <form
        className="free"
        onSubmit={(e) => {
          e.preventDefault()
          void go(text)
        }}
      >
        <label htmlFor={inputId}>Jawaban sendiri untuk: {d.title}</label>
        <input
          id={inputId}
          value={text}
          maxLength={MAX_ANSWER_LENGTH}
          disabled={sending}
          placeholder="Atau tulis jawaban lain…"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="tm-btn primary" disabled={sending || !text.trim()}>
          Kirim
        </button>
      </form>
      <div className="send-state" role="status" aria-live="polite">
        {state.kind === 'sending' && <span>Lagi ngirim jawaban…</span>}
        {state.kind === 'error' && <span className="err">{state.message}</span>}
      </div>
    </div>
  )
}

/** Small icon button that cycles Terang, Gelap, Sistem. Sun, moon, or a half-filled circle for "follow the system". */
function ThemeButton({ theme, onCycle }: { theme: ThemePref; onCycle: () => void }) {
  const { icon, label } = themeButton(theme)
  return (
    <button type="button" className="tm-icon-btn" aria-label={label} title={label} onClick={onCycle}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {icon === 'sun' && (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </>
        )}
        {icon === 'moon' && <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />}
        {icon === 'auto' && (
          <>
            <circle cx="12" cy="12" r="8" />
            <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
          </>
        )}
      </svg>
    </button>
  )
}

function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="tm-empty-state">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  )
}

/** Offboarded agents of this project (D22), collapsed: history stays reachable, the graph stays clean. */
function OffboardedList({ model }: { model: TeamModel }) {
  const list = model.offboarded
  const count = list.status === 'ready' ? list.rows.length : null
  return (
    <details className="tm-list tm-offboarded">
      <summary>
        <span>Selesai kontrak</span>
        <span className="note">{count === null ? '' : `${count} agent`}</span>
      </summary>
      {list.status === 'loading' && <div className="tm-row">Lagi memuat…</div>}
      {list.status === 'error' && (
        <div className="tm-row err-row">
          <span className="ttl">{list.message}</span>
          <button type="button" className="tm-btn" onClick={model.reloadOffboarded}>
            Coba lagi
          </button>
        </div>
      )}
      {list.status === 'ready' && list.rows.length === 0 && (
        <div className="tm-row">
          <span className="ttl">
            Belum ada. Agent yang sudah selesai bisa di-offboard dari grafik: ketuk agent-nya lalu pilih Offboard.
          </span>
        </div>
      )}
      {list.status === 'ready' &&
        list.rows.map((r) => (
          <div className="tm-row tm-off-row" key={r.key}>
            <div className="ttl">
              <div className="nm">
                {r.name}
                {r.role && <span className="rl"> · {r.role}</span>}
              </div>
              {r.task && <div className="tk">{r.task}</div>}
              {r.when && <div className="wh">{r.when}</div>}
            </div>
          </div>
        ))}
    </details>
  )
}

export function TeamPanel({ model, theme, onCycleTheme, chatRef }: PanelProps) {
  const { vm, view } = model
  const seenRef = useRef<Set<string> | null>(null)
  const keys = vm.live.map((t) => `${t.id}:${t.status}`)
  const fresh = newBubbleKeys(seenRef.current, keys)
  const ready = view === 'ready'
  useEffect(() => {
    seenRef.current = ready ? new Set(keys) : null
  })
  // With several projects the theme button sits next to the project switcher; with one, next to the title.
  const hasSwitcher = model.projects.length > 1

  return (
    <div className="tm-wrap">
      {hasSwitcher && (
        <div className="tm-switch">
          <label htmlFor="tm-project">Proyek</label>
          <div className="tm-switch-row">
            <select id="tm-project" value={model.selectedId ?? ''} onChange={(e) => model.selectProject(e.target.value)}>
              {model.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.hasState ? '' : ' (belum ada data)'}
                </option>
              ))}
            </select>
            <ThemeButton theme={theme} onCycle={onCycleTheme} />
          </div>
        </div>
      )}

      <header className="tm-top">
        <div className="tm-heading">
          <h1>{ready ? vm.title : model.projectName || 'Monitor tim'}</h1>
          {ready && vm.statusText && <p className="sub">{vm.statusText}</p>}
        </div>
        {!hasSwitcher && <ThemeButton theme={theme} onCycle={onCycleTheme} />}
      </header>

      <div className="tm-banners" role="status" aria-live="polite">
        {model.listError && <div className="tm-banner err">{model.listError}</div>}
        {model.connection === 'reconnecting' && view !== 'loading' && (
          <div className="tm-banner err">Terputus, menyambung ulang…</div>
        )}
        {model.connection === 'connecting' && view === 'loading' && <div className="tm-banner">Menyambung…</div>}
        {model.stateError && <div className="tm-banner err">{model.stateError}</div>}
        {process.env.TEAM_MONITOR_FIXTURE === '1' && (
          <div className="tm-banner">Data contoh untuk lihat tampilan, bukan data asli.</div>
        )}
      </div>

      {view === 'loading' && !model.listError && <div className="tm-banner">Lagi memuat daftar proyek…</div>}
      {view === 'connecting' && <div className="tm-banner">Lagi memuat catatan tim…</div>}
      {view === 'no-projects' && (
        <Empty title="Belum ada proyek">
          Monitor belum tahu folder proyek mana yang dipantau. Jalankan dengan <code>--project &lt;folder&gt;</code> atau isi
          daftar proyek di <code>~/.team-monitor/config.json</code>, lalu muat ulang halaman ini.
        </Empty>
      )}
      {view === 'no-data' && (
        <Empty title="Belum ada data tim">
          Proyek ini belum punya catatan tim. Begitu koordinator menulis <code>.agent-team/state.json</code>, tampilannya
          muncul di sini sendiri.
        </Empty>
      )}
      {view === 'no-data' && model.hasPayload && (
        <ChatSection
          ref={chatRef}
          thread={model.thread}
          coordinatorName={model.coordinatorName}
          watcherNotice={model.watcherNotice}
          send={model.sendMessage}
        />
      )}

      {ready && (
        <>
          <section className="tm-stats" aria-label="Ringkasan">
            <div className="tm-stat">
              <b>
                {vm.stagesDone}
                <small>/{vm.stagesTotal}</small>
              </b>
              <span>Tahap selesai</span>
            </div>
            <div className="tm-stat">
              <b>
                {vm.tasksDone}
                <small>/{vm.tasksTotal}</small>
              </b>
              <span>Task selesai</span>
              <div className="dots" aria-hidden="true">
                {vm.dots.map((d, i) => (
                  <i key={i} className={d} />
                ))}
              </div>
            </div>
            <a className={`tm-stat${vm.openDecisions > 0 ? ' hot' : ''}`} href="#keputusan">
              <b>{vm.openDecisions}</b>
              <span>Butuh kamu</span>
            </a>
          </section>

          <h2>Tim</h2>
          <section className="tm-team" aria-label="Susunan tim">
            <div className="owner">
              <span>{OWNER_LABEL}</span>
            </div>
            {vm.lead && (
              <>
                <div className="stem" />
                <div className="lead-row">
                  <Member m={vm.lead} lead />
                </div>
              </>
            )}
            {vm.members.length > 0 && (
              <>
                <div className="stem" />
                <div className="bar" />
                <div className="members">
                  {vm.members.map((m) => (
                    <Member key={m.id} m={m} />
                  ))}
                </div>
              </>
            )}
            {!vm.lead && vm.members.length === 0 && <div className="tm-empty">Belum ada anggota tim di catatan.</div>}
          </section>

          <h2>Lagi dikerjain</h2>
          <div aria-live="polite">
            {vm.live.length === 0 ? (
              <div className="tm-empty">Nggak ada yang lagi jalan. Tim lagi siaga.</div>
            ) : (
              <div className="tm-bubbles">
                {vm.live.map((t) => (
                  <Bubble key={t.id} t={t} fresh={fresh.has(`${t.id}:${t.status}`)} />
                ))}
              </div>
            )}
          </div>

          <details className="tm-list">
            <summary>
              <span>Antrian dan yang sudah selesai</span>
              <span className="note">{vm.queue.length} task</span>
            </summary>
            {vm.queue.length === 0 && <div className="tm-row">Belum ada.</div>}
            {vm.queue.map((t) => (
              <div className="tm-row" key={t.id}>
                <span className="ttl">{t.title}</span>
                <span className={`tm-chip ${t.status}`}>{t.statusLabel}</span>
              </div>
            ))}
          </details>

          <OffboardedList model={model} />

          <h2 id="keputusan">Keputusan</h2>
          {vm.decisions.length === 0 ? (
            <div className="tm-empty">Belum ada keputusan yang perlu kamu ambil.</div>
          ) : (
            vm.decisions.map((d) => <Decision key={d.id} d={d} send={model.sendAnswer} />)
          )}

          <ChatSection
            ref={chatRef}
            thread={model.thread}
            coordinatorName={model.coordinatorName}
            watcherNotice={model.watcherNotice}
            send={model.sendMessage}
          />

          <div className="tm-grid2">
            <div>
              <h2>Tahapan</h2>
              {vm.stages.length === 0 ? (
                <div className="tm-empty">Belum ada tahapan.</div>
              ) : (
                <div className="tm-stages">
                  {vm.stages.map((s) => (
                    <div className={`tm-stage ${s.status}`} key={s.id}>
                      <div className="ix" aria-hidden="true">
                        {s.marker}
                      </div>
                      <div className="mid">
                        <div className="lb">{s.label}</div>
                        {s.sub && <div className="sb">{s.sub}</div>}
                        <div
                          className="track"
                          role="progressbar"
                          aria-label={`Kemajuan ${s.label}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={s.percent}
                        >
                          <i style={{ width: `${s.percent}%` }} />
                        </div>
                      </div>
                      <div className="pc">{s.percent}%</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h2>Catatan terbaru</h2>
              {vm.log.length === 0 ? (
                <div className="tm-empty">Belum ada catatan.</div>
              ) : (
                <div className="tm-log">
                  {vm.log.map((r) => (
                    <div className="tm-row" key={r.id}>
                      <span className="ttl">{r.text}</span>
                      <time>{r.time}</time>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
