// Heatmap time control: native range input (keyboard and screen-reader friendly) plus a
// play button. Moving it writes hourStore; the map repaints at most once per frame.
import { useEffect, useRef, useState } from 'react'
import type { Plan, ScoreOut } from '../api/client'
import { clock, num } from '../lib/format'
import { hourStore, useHour } from '../lib/hourStore'
import { LEVELS, levelAt, type WindMode } from '../lib/risk'

interface Props {
  hours: number[]
  departure: number
  timeZone: string
  plan: Plan
  score: ScoreOut | null
  selected: number
  mode: WindMode
  onMode: (m: WindMode) => void
  heatmapOn: boolean
  onHeatmap: (on: boolean) => void
}

const STEP_MS = 450

/** Where the truck on the selected route is at time t, and the conditions it meets there. */
function readout(plan: Plan, score: ScoreOut | null, mode: WindMode, route: number, t: number): string {
  const cps = plan.checkpoints.features.map((f, i) => ({ f, i })).filter(({ f }) => f.properties.route === route)
  const last = cps[cps.length - 1]
  if (!last) return ''
  const name = plan.routes.features[route]?.properties.name ?? ''
  if (t >= last.f.properties.eta) return `Route ${name}: arrived`
  // The checkpoint the truck is passing (the last one it has reached).
  let at = cps[0]!
  for (const c of cps) if (c.f.properties.eta <= t) at = c
  const stop = plan.routes.features[route]?.properties.stops.find((s) => s.at <= t && t < s.at + s.duration_s)
  const where = stop
    ? `${stop.kind === 'rest' ? 'resting' : 'on break'}${stop.place ? ` at ${stop.place.name}` : ''}`
    : `near mile ${Math.round(at.f.properties.mile).toLocaleString('en-US')}`
  if (!score) return `Route ${name}: truck ${where}`
  const c = score.conditions[at.i]
  const lvl = levelAt(score[mode].checkpoint_levels, at.i)
  const wind = mode === 'gust' ? `gusts ${num(c?.gust, 0, 'mph')}` : `wind ${num(c?.wind, 0, 'mph')}`
  return `Route ${name}: truck ${where} · ${wind} · ${lvl === null ? 'no forecast' : LEVELS[lvl]}`
}

export default function Timeline({ hours, departure, timeZone, plan, score, selected, mode, onMode, heatmapOn, onHeatmap }: Props) {
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
  const t0 = hours[0] ?? departure
  const span = (hours[max] ?? departure) - t0 || 1
  const route = plan.routes.features[selected]?.properties
  const marks = route
    ? [
        { at: departure, cls: 'start', label: 'Depart' },
        ...route.stops.map((s) => ({ at: s.at, cls: s.kind, label: s.kind === 'rest' ? 'Rest' : 'Break' })),
        { at: departure + route.trip_s, cls: 'end', label: 'Arrive' },
      ].filter((m) => m.at >= t0 && m.at <= t0 + span)
    : []
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
          <span className={hour > 48 ? 'late' : 'muted'}>
            +{hour} h{hour > 48 ? ' · beyond 48 h, forecasts are less reliable' : ''}
          </span>
        </div>
        <div className="readout" aria-live="polite">{readout(plan, score, mode, selected, t)}</div>
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
        <div className="marks" aria-hidden>
          {marks.map((m, i) => (
            <span key={i} className={`mark ${m.cls}`} style={{ left: `${((m.at - t0) / span) * 100}%` }} title={`${m.label} ${clock(m.at, timeZone)}`}>
              <i />
            </span>
          ))}
        </div>
        <div className="ticks" aria-hidden>
          {Array.from({ length: 5 }, (_, k) => (
            <span key={k}>{clock(t0 + (span * k) / 4, timeZone, true).replace(/:00/, '')}</span>
          ))}
        </div>
      </div>
      <div className="toggles">
        <div className="seg small" role="radiogroup" aria-label="Wind value used for risk">
          <button type="button" role="radio" aria-checked={mode === 'gust'} className={mode === 'gust' ? 'on' : undefined} onClick={() => onMode('gust')} title="Rate wind on gusts, which is what blows trucks over (default)">
            Gusts
          </button>
          <button type="button" role="radio" aria-checked={mode === 'sustained'} className={mode === 'sustained' ? 'on' : undefined} onClick={() => onMode('sustained')} title="Rate wind on sustained speed instead">
            Sustained
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
