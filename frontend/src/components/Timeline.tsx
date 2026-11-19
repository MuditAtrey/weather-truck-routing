// Heatmap time control: native range input (keyboard and screen-reader friendly) plus a
// play button. Moving it writes hourStore; the map repaints at most once per frame.
import { useEffect, useRef, useState } from 'react'
import { clock } from '../lib/format'
import { hourStore, useHour } from '../lib/hourStore'
import type { WindMode } from '../lib/risk'

interface Props {
  hours: number[]
  departure: number
  timeZone: string
  mode: WindMode
  onMode: (m: WindMode) => void
  heatmapOn: boolean
  onHeatmap: (on: boolean) => void
}

const STEP_MS = 450

export default function Timeline({ hours, departure, timeZone, mode, onMode, heatmapOn, onHeatmap }: Props) {
  const hour = useHour()
  const [playing, setPlaying] = useState(false)
  const raf = useRef(0)
  const max = hours.length - 1

  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const tick = (now: number) => {
      if (now - last >= STEP_MS) {
        last = now
        const next = hourStore.get() + 1
        if (next > max) {
          setPlaying(false)
          return
        }
        hourStore.set(next)
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    const stop = () => document.hidden && setPlaying(false)
    document.addEventListener('visibilitychange', stop)
    return () => {
      cancelAnimationFrame(raf.current)
      document.removeEventListener('visibilitychange', stop)
    }
  }, [playing, max])

  const t = hours[hour] ?? departure
  return (
    <div className="timeline" role="group" aria-label="Weather heatmap time">
      <button
        type="button"
        className="play"
        onClick={() => {
          if (!playing && hourStore.get() >= max) hourStore.set(0)
          setPlaying((p) => !p)
        }}
        aria-label={playing ? 'Pause' : 'Play forecast'}
      >
        {playing ? (
          <svg viewBox="0 0 16 16" aria-hidden><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden><path d="M4 2.5v11l9.5-5.5z" /></svg>
        )}
      </button>
      <div className="slider">
        <div className="slider-label">
          <strong>{clock(t, timeZone)}</strong>
          <span className="muted">hour {hour} of {max} after departure</span>
        </div>
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={hour}
          onChange={(e) => {
            setPlaying(false)
            hourStore.set(Number(e.target.value))
          }}
          aria-valuetext={clock(t, timeZone)}
          aria-label="Forecast hour"
        />
        <div className="ticks" aria-hidden>
          <span>0 h</span>
          <span>12 h</span>
          <span>24 h</span>
          <span>36 h</span>
          <span>48 h</span>
        </div>
      </div>
      <div className="toggles">
        <div className="seg small" role="radiogroup" aria-label="Wind value used for risk">
          <button type="button" role="radio" aria-checked={mode === 'sustained'} className={mode === 'sustained' ? 'on' : undefined} onClick={() => onMode('sustained')} title="Rate wind on sustained speed (the brief's table)">
            Sustained
          </button>
          <button type="button" role="radio" aria-checked={mode === 'gust'} className={mode === 'gust' ? 'on' : undefined} onClick={() => onMode('gust')} title="Conservative: rate wind on gusts">
            Gusts
          </button>
        </div>
        <label className="check small">
          <input type="checkbox" checked={heatmapOn} onChange={(e) => onHeatmap(e.target.checked)} />
          Heatmap
        </label>
      </div>
    </div>
  )
}
