"use client"

import { useEffect, useId, useRef, useState } from 'react'
import { MAX_ANSWER_LENGTH, type AnswerResult } from '@/lib/team/answer'
import { OWNER_LABEL } from '@/lib/team/labels'
import { newBubbleKeys, themeLabel, type ThemePref } from '@/lib/team/session'
import type { DecisionVM, MemberVM, TaskVM } from '@/lib/team/view-model'
import type { TeamModel } from './use-team-model'
import { useSoundSettings } from '@/hooks/use-sound-settings'

interface PanelProps {
  model: TeamModel
  theme: ThemePref
  onCycleTheme: () => void
  calm: boolean
  onToggleCalm: () => void
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

/** Same mute and volume as the graph's top bar; on a phone the panel is the main view, so it lives here too. */
function SoundControls() {
  const sound = useSoundSettings()
  const volumeId = useId()
  return (
    <>
      <button
        type="button"
        className="tm-btn"
        aria-pressed={!sound.muted}
        title={sound.muted ? 'Nyalakan suara' : 'Matikan suara'}
        onClick={sound.toggle}
      >
        {sound.muted ? 'Suara: mati' : 'Suara: nyala'}
      </button>
      {!sound.muted && (
        <div className="tm-volume">
          <label htmlFor={volumeId}>Volume</label>
          <input
            id={volumeId}
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(sound.volume * 100)}
            onChange={(e) => sound.setVolume(Number(e.target.value) / 100)}
          />
        </div>
      )}
    </>
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

export function TeamPanel({ model, theme, onCycleTheme, calm, onToggleCalm }: PanelProps) {
  const { vm, view } = model
  const seenRef = useRef<Set<string> | null>(null)
  const keys = vm.live.map((t) => `${t.id}:${t.status}`)
  const fresh = newBubbleKeys(seenRef.current, keys)
  const ready = view === 'ready'
  useEffect(() => {
    seenRef.current = ready ? new Set(keys) : null
  })

  return (
    <div className="tm-wrap">
      <header className="tm-top">
        <div className="tm-heading">
          <h1>{ready ? vm.title : model.projectName || 'Monitor tim'}</h1>
          {ready && vm.statusText && <p className="sub">{vm.statusText}</p>}
        </div>
        <div className="tm-tools">
          <SoundControls />
          <button type="button" className="tm-btn" aria-pressed={calm} onClick={onToggleCalm}>
            {calm ? 'Putar animasi' : 'Jeda animasi'}
          </button>
          <button type="button" className="tm-btn" onClick={onCycleTheme}>
            Tema: {themeLabel(theme)}
          </button>
        </div>
      </header>

      {model.projects.length > 1 && (
        <div className="tm-switch">
          <label htmlFor="tm-project">Proyek</label>
          <select id="tm-project" value={model.selectedId ?? ''} onChange={(e) => model.selectProject(e.target.value)}>
            {model.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.hasState ? '' : ' (belum ada data)'}
              </option>
            ))}
          </select>
        </div>
      )}

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

          <h2 id="keputusan">Keputusan</h2>
          {vm.decisions.length === 0 ? (
            <div className="tm-empty">Belum ada keputusan yang perlu kamu ambil.</div>
          ) : (
            vm.decisions.map((d) => <Decision key={d.id} d={d} send={model.sendAnswer} />)
          )}

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
