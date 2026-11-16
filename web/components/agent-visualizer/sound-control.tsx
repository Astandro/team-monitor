"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { COLORS } from "@/lib/colors"
import { useGraphTheme } from "@/hooks/use-graph-theme"
import { useClickOutside } from "@/hooks/use-click-outside"
import { useSoundSettings } from "@/hooks/use-sound-settings"
import { soundButtonLabel, volumePercent } from "@/lib/sound/control-labels"
import { DEMO_ORDER } from "@/lib/sound/demo"
import { SOUND_CREDIT } from "@/lib/sound/samples"
import { startSoundDemo } from "@/lib/sound/sound-client"

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {muted ? (
        <>
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </>
      ) : (
        <>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        </>
      )}
    </svg>
  )
}

function CaretIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={open ? "6 15 12 9 18 15" : "6 9 12 15 18 9"} />
    </svg>
  )
}

/**
 * The page's one sound control (owner request 13 Nov): a speaker button that mutes and unmutes, and the volume
 * slider in a small popover opened by the caret next to it. Same state as everything that plays a sound
 * (useSoundSettings), so the team panel needs no control of its own. The popover closes on Escape, on a click
 * outside, and gives focus back to the caret.
 */
export function SoundControl() {
  useGraphTheme()
  const sound = useSoundSettings()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const caretRef = useRef<HTMLButtonElement>(null)
  const sliderRef = useRef<HTMLInputElement>(null)
  const popId = useId()
  const sliderId = useId()
  const close = useCallback(() => setOpen(false), [])
  useClickOutside(wrapRef, close)

  useEffect(() => {
    if (open) sliderRef.current?.focus()
  }, [open])

  // "Coba suara": each sound in turn with its name; stops when the popover closes or the control goes away
  const [demo, setDemo] = useState<string | null>(null)
  const stopDemoRef = useRef<(() => void) | null>(null)
  const stopDemo = useCallback(() => {
    stopDemoRef.current?.()
    stopDemoRef.current = null
  }, [])
  const toggleDemo = () => {
    if (stopDemoRef.current) stopDemo()
    else stopDemoRef.current = startSoundDemo((step) => {
      setDemo(step)
      if (step === null) stopDemoRef.current = null
    })
  }
  useEffect(() => {
    if (!open) stopDemo()
  }, [open, stopDemo])
  useEffect(() => stopDemo, [stopDemo])

  const label = soundButtonLabel(sound.muted)
  const pct = volumePercent(sound.volume)
  const btn: React.CSSProperties = {
    background: sound.muted ? COLORS.toggleInactive : COLORS.toggleActive,
    border: `1px solid ${sound.muted ? COLORS.toggleBorder : COLORS.tabSelectedBorder}`,
    color: sound.muted ? COLORS.textMuted : COLORS.thinking,
  }

  return (
    <div
      ref={wrapRef}
      className="tm-sound relative inline-flex items-stretch"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation()
          setOpen(false)
          caretRef.current?.focus()
        }
      }}
    >
      <button
        type="button"
        onClick={sound.toggle}
        aria-pressed={!sound.muted}
        aria-label={label}
        title={label}
        className="tm-sound-btn inline-flex items-center justify-center"
        style={{ ...btn, borderRadius: "10px 0 0 10px", minWidth: 36, minHeight: 32 }}
      >
        <SpeakerIcon muted={sound.muted} />
      </button>
      <button
        ref={caretRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={popId}
        aria-label={`Atur volume, sekarang ${pct}%`}
        title={`Volume ${pct}%`}
        className="tm-sound-btn inline-flex items-center justify-center"
        style={{ ...btn, borderLeft: "none", borderRadius: "0 10px 10px 0", minWidth: 28, minHeight: 32 }}
      >
        <CaretIcon open={open} />
      </button>
      {open && (
        <div
          id={popId}
          className="glass-card absolute right-0 flex flex-col gap-2"
          style={{ top: "calc(100% + 6px)", padding: "10px 12px", zIndex: 5, width: 260, maxWidth: "calc(100vw - 32px)", color: COLORS.textPrimary }}
        >
          <div className="flex items-center gap-3">
            <label htmlFor={sliderId} className="text-[12px] font-semibold" style={{ color: COLORS.textMuted }}>
              Volume
            </label>
            <input
              ref={sliderRef}
              id={sliderId}
              type="range"
              min={0}
              max={100}
              step={5}
              value={pct}
              onChange={(e) => sound.setVolume(Number(e.target.value) / 100)}
              className="flex-1 min-w-0"
              style={{ accentColor: COLORS.thinking, minHeight: 32 }}
            />
            <span className="text-[12px] tabular-nums" style={{ color: COLORS.textPrimary, minWidth: 34, textAlign: "right" }}>
              {pct}%
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleDemo}
              aria-pressed={demo !== null}
              className="tm-sound-btn shrink-0 text-[12px] font-semibold"
              style={{
                background: COLORS.toggleInactive,
                border: `1px solid ${COLORS.toggleBorder}`,
                color: COLORS.textPrimary,
                borderRadius: 10,
                minHeight: 32,
                padding: "0 12px",
              }}
            >
              {demo === null ? "Coba suara" : "Berhenti"}
            </button>
            <span aria-live="polite" className="text-[12px]" style={{ color: demo === null ? COLORS.textMuted : COLORS.textPrimary }}>
              {demo ?? (sound.muted ? `Nyalakan suara, putar ${DEMO_ORDER.length} suara` : `${DEMO_ORDER.length} suara, satu per satu`)}
            </span>
          </div>
          <p className="tm-sound-credit text-[11px] leading-snug" style={{ color: COLORS.textMuted, margin: 0 }}>
            Suara:{" "}
            <a href={SOUND_CREDIT.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: COLORS.textPrimary, textDecoration: "underline" }}>
              {SOUND_CREDIT.pack}
            </a>{" "}
            oleh {SOUND_CREDIT.author},{" "}
            <a href={SOUND_CREDIT.licenceUrl} target="_blank" rel="noopener noreferrer" style={{ color: COLORS.textPrimary, textDecoration: "underline" }}>
              {SOUND_CREDIT.licence}
            </a>
            , {SOUND_CREDIT.modified}.
          </p>
        </div>
      )}
    </div>
  )
}
