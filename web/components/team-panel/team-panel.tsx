"use client"

import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { MAX_ANSWER_LENGTH, type AnswerResult } from '@/lib/team/answer'
import { burstPeriod, DISINTEGRATING_TAG, disintegrationLook, flickerPeriod, OUTLINE_PIECES } from '@/lib/disintegration'
import { WARNING_ICON } from '@/lib/alert-tag'
import { OWNER_LABEL } from '@/lib/team/labels'
import { groupMembers } from '@/lib/team/groups'
import { BotAvatar } from '../bot-avatar'
import { dashArrayFromPieces } from '@/lib/team/members'
import { ANSWERED_OPEN_BY_DEFAULT, answeredSummary, panelSections, splitDecisions, type SectionKey } from '@/lib/team/sections'
import { newBubbleKeys, themeButton, type ThemePref } from '@/lib/team/session'
import type { DecisionVM, MemberVM, TaskVM } from '@/lib/team/view-model'
import type { TeamModel } from './use-team-model'

interface PanelProps {
  model: TeamModel
  theme: ThemePref
  onCycleTheme: () => void
  /** Desktop only: hide the panel so the graph takes the full width. */
  onHide?: () => void
}

function Avatar({ tone, initial, name, coordinator, working, size }: {
  tone: string
  initial: string
  /** Bot avatar for this name (web/lib/bot-avatar.ts); without a name the initial stays */
  name?: string
  coordinator?: boolean
  working?: boolean
  size?: 'lead'
}) {
  return (
    <div className={`tm-av ${tone}${name ? ' has-bot' : ''}${working ? ' working' : ''}${size === 'lead' ? ' big' : ''}`} aria-hidden="true">
      {name ? <BotAvatar name={name} coordinator={coordinator} /> : initial}
      {working !== undefined && <span className={`st ${working ? 'work' : 'idle'}`} />}
    </div>
  )
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = (e: MediaQueryListEvent) => setReduce(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduce
}

/**
 * A retired member's avatar, the same idea as the graph's node: the outline breaks up piece by piece over the hour
 * (the share left reads as time left), the body fades to 30%. Reduced motion: whole outline, plain fade.
 */
function LeavingAvatar({ m, reduce }: { m: MemberVM; reduce: boolean }) {
  const look = disintegrationLook(m.id, m.progress, reduce)
  const dash = look.pieces ? dashArrayFromPieces(look.pieces) : 'none'
  // Quiet light bursts, more often as the hour runs out (item 7); the CSS drops them under reduced motion
  const motion = reduce ? undefined : ({ '--tm-burst': `${burstPeriod(m.progress).toFixed(2)}s` } as React.CSSProperties)
  return (
    <div className={`tm-av leaving${reduce ? '' : ' bursting'}`} style={motion} aria-hidden="true">
      <span className={`body ${m.tone}`} style={{ opacity: look.body }}>
        <BotAvatar name={m.nick} coordinator={m.isLead} />
      </span>
      <svg className="edge" viewBox="0 0 34 34" preserveAspectRatio="none">
        <rect
          x="0.75"
          y="0.75"
          width="32.5"
          height="32.5"
          rx="9.5"
          pathLength={OUTLINE_PIECES}
          strokeDasharray={dash}
          style={{ opacity: look.pieces ? 1 : look.body }}
        />
      </svg>
    </div>
  )
}

/** One compact row in the tree: avatar, name with role and model, then what they are on (or that they are leaving). */
function Member({ m, lead, reduce }: { m: MemberVM; lead?: boolean; reduce: boolean }) {
  const leaving = m.phase === 'offboarding'
  const label = leaving ? disintegrationLook(m.id, m.progress, reduce).label : 1
  const sub = [m.role, m.model].filter(Boolean).join(' · ')
  return (
    <div className={`tm-member${leaving ? ' leaving' : ''}`}>
      {leaving ? (
        <LeavingAvatar m={m} reduce={reduce} />
      ) : (
        <Avatar
          tone={m.tone}
          initial={m.initial}
          name={m.nick}
          coordinator={m.isLead}
          working={m.working}
          size={lead ? 'lead' : undefined}
        />
      )}
      <div className="who">
        <div className="line" style={label < 1 ? { opacity: Math.max(label, 0.35) } : undefined}>
          <span className="nm">{m.nick}</span>
          {leaving && (
            // Item 4 (owner correction): the tag is the alert and it is what blinks; the name stays steady
            <span
              className={`tm-alert-tag${reduce ? '' : ' blink'}`}
              style={reduce ? undefined : ({ '--tm-flicker': `${flickerPeriod(m.progress).toFixed(2)}s` } as React.CSSProperties)}
            >
              <svg viewBox={WARNING_ICON.viewBox} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round">
                <path d={WARNING_ICON.triangle} />
                <path d={WARNING_ICON.mark} />
                <circle cx={WARNING_ICON.dot.cx} cy={WARNING_ICON.dot.cy} r={WARNING_ICON.dot.r} fill="currentColor" stroke="none" />
              </svg>
              {DISINTEGRATING_TAG}
            </span>
          )}
          {sub && <span className="rl"> {sub}</span>}
        </div>
        {leaving ? (
          <div className="tk idle">{m.leaving}</div>
        ) : m.working ? (
          <div className="tk">
            <span className="sr-only">Lagi ngerjain: </span>
            {m.task || 'Lagi kerja'}
          </div>
        ) : lead ? (
          <div className="tk idle">Siaga</div>
        ) : null}
      </div>
    </div>
  )
}

/** Sidebar glyph: a panel outline with its left column and a chevron pointing the way it will move. */
function PanelIcon({ dir }: { dir: 'hide' | 'show' }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
      <path d={dir === 'hide' ? 'M16 10l-2 2 2 2' : 'M14 10l2 2-2 2'} />
    </svg>
  )
}

function Bubble({ t, fresh }: { t: TaskVM; fresh: boolean }) {
  return (
    <div className={`tm-bubble${t.status === 'running' ? ' running' : ''}${fresh ? ' enter' : ''}`}>
      <Avatar tone={t.tone} initial={t.initial} name={t.avatarName || undefined} coordinator={t.avatarLead} />
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

/** Answered decisions, one row each (title, then the answer), all behind one collapsed "N sudah dijawab" (item 3). */
function AnsweredDecisions({ list }: { list: DecisionVM[] }) {
  return (
    <details className="tm-list tm-answered" open={ANSWERED_OPEN_BY_DEFAULT || undefined}>
      <summary>
        <span>Keputusan</span>
        <span className="note">{answeredSummary(list.length)}</span>
      </summary>
      {list.map((d) => (
        <div className="tm-row" key={d.id}>
          <div className="ttl">
            <div className="q">{d.title}</div>
            <div className="ans">
              {d.answer ? (
                <>
                  <span className="sr-only">Jawaban: </span>
                  {d.answer}
                </>
              ) : (
                'Sudah dijawab'
              )}
            </div>
          </div>
        </div>
      ))}
    </details>
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
                {r.auto && (
                  <span className="tm-chip auto" title="Di-offboard otomatis satu jam setelah selesai">
                    otomatis
                  </span>
                )}
              </div>
              {r.task && <div className="tk">{r.task}</div>}
              {r.when && <div className="wh">{r.when}</div>}
            </div>
          </div>
        ))}
    </details>
  )
}

export function TeamPanel({ model, theme, onCycleTheme, onHide }: PanelProps) {
  const { vm, view } = model
  const reduce = usePrefersReducedMotion()
  const seenRef = useRef<Set<string> | null>(null)
  const keys = vm.live.map((t) => `${t.id}:${t.status}`)
  const fresh = newBubbleKeys(seenRef.current, keys)
  const ready = view === 'ready'
  useEffect(() => {
    seenRef.current = ready ? new Set(keys) : null
  })
  // With several projects the theme button sits next to the project switcher; with one, next to the title.
  const hasSwitcher = model.projects.length > 1
  const decisionGroups = splitDecisions(vm.decisions)

  // One block per section; the order comes from SECTION_ORDER (web/lib/team/sections.ts, tested).
  const sections: Record<SectionKey, React.ReactNode> = {
    stages: (
      <>
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
      </>
    ),
    live: (
      <>
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
      </>
    ),
    decisions: (
      <>
        <h2 id="keputusan">Keputusan</h2>
        {decisionGroups.open.length === 0 ? (
          <div className="tm-empty">Belum ada keputusan yang perlu kamu ambil.</div>
        ) : (
          decisionGroups.open.map((d) => <Decision key={d.id} d={d} send={model.sendAnswer} />)
        )}
      </>
    ),
    team: (
      <>
        <h2>Tim</h2>
        <section className="tm-team" aria-label="Susunan tim">
          <div className="owner">
            <span>{OWNER_LABEL}</span>
          </div>
          {vm.lead && (
            <div className="lead-row">
              <Member m={vm.lead} lead reduce={reduce} />
            </div>
          )}
          {groupMembers(vm.members).map((g) => (
            <div className={`tm-group ${g.key}${vm.lead ? ' under-lead' : ''}`} key={g.key} role="group" aria-labelledby={`tm-group-${g.key}`}>
              <h3 className="tm-group-title" id={`tm-group-${g.key}`}>
                {g.label} <span className="ct">{g.members.length}</span>
              </h3>
              <ul className={`members${vm.lead ? ' under-lead' : ''}`}>
                {g.members.map((m) => (
                  <li key={m.id}>
                    <Member m={m} reduce={reduce} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {!vm.lead && vm.members.length === 0 && <div className="tm-empty">Belum ada anggota tim di catatan.</div>}
        </section>
      </>
    ),
    queue: (
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
    ),
    offboarded: <OffboardedList model={model} />,
    answered: <AnsweredDecisions list={decisionGroups.answered} />,
  }

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
        <div className="tm-top-actions">
          {onHide && (
            <button
              type="button"
              id="tm-panel-toggle"
              className="tm-icon-btn tm-desk-only"
              aria-label="Sembunyikan panel tim (tombol [)"
              title="Sembunyikan panel tim (tombol [)"
              aria-controls="tm-panel-tim"
              aria-expanded="true"
              onClick={onHide}
            >
              <PanelIcon dir="hide" />
            </button>
          )}
          {!hasSwitcher && <ThemeButton theme={theme} onCycle={onCycleTheme} />}
        </div>
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

          {panelSections(decisionGroups.answered.length).map((k) => (
            <Fragment key={k}>{sections[k]}</Fragment>
          ))}
        </>
      )}
    </div>
  )
}

