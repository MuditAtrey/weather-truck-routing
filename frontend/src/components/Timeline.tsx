// The trip clock: drag or play through time and watch the truck drive the forecast.
//
// Under the slider, a strip shows the risk the truck itself meets each hour (not the
// worst anywhere), and an event row shows departure, breaks, rests and arrival with the
// same symbols as the map. Moving the slider writes hourStore; the map repaints at most
// once per frame and the rest of the app does not re-render.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Plan, ScoreOut } from '../api/client'
import { clock, num } from '../lib/format'
import { hourStore, useHour } from '../lib/hourStore'
import { LEVEL_COLORS, LEVELS, UNKNOWN_COLOR, levelAt, type WindMode } from '../lib/risk'
import { stopSymbol } from '../lib/symbols'
import { createTrack } from '../lib/track'
import { nearestPlace } from '../lib/verdict'
import Symbol from './Symbol'

interface Props {
  plan: Plan
  score: ScoreOut | null
  selected: number
  mode: WindMode
  /** Called when playback starts or stops (the map follows the truck while playing). */
  onPlaying: (playing: boolean) => void
}

const STEP_MS = 450

const partsCache = new Map<string, Intl.DateTimeFormat>()
function localParts(epochS: number, timeZone: string) {
  let f = partsCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', day: 'numeric', hour: 'numeric', hourCycle: 'h23' })
    partsCache.set(timeZone, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(epochS * 1000)).map((x) => [x.type, x.value]))
  return { weekday: p.weekday as string, day: p.day as string, hour: Number(p.hour) % 24 }
}

function hourLabel(h: number) {
  return h === 0 ? '12 AM' : h === 12 ? 'Noon' : h < 12 ? `${h} AM` : `${h - 12} PM`
}

export default function Timeline({ plan, score, selected, mode, onPlaying }: Props) {
  const hour = useHour()
  const [playing, setPlaying] = useState(false)
  const raf = useRef(0)
  const { hours, departure, timezone: timeZone } = plan
  const max = hours.length - 1
  const track = useMemo(() => createTrack(plan, selected), [plan, selected])
  const route = plan.routes.features[selected]?.properties

  useEffect(() => {
    onPlaying(playing)
  }, [playing])

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

  const t0 = hours[0] ?? departure
  const span = (hours[max] ?? departure) - t0 || 1
  const pct = (t: number) => `${Math.max(0, Math.min(100, ((t - t0) / span) * 100))}%`

  // What the truck meets each hour, as one CSS gradient (cheap for hundreds of hours).
  const strip = useMemo(() => {
    if (!track || !score) return undefined
    const levels = score[mode].checkpoint_levels
    const stops: string[] = []
    hours.forEach((t, h) => {
      const s = track.at(t)
      const c =
        s.status === 'before' || s.status === 'arrived'
          ? 'transparent'
          : (() => {
              const l = levelAt(levels, s.cp)
              return l === null ? UNKNOWN_COLOR : LEVEL_COLORS[l]
            })()
      const a = (h / (max || 1)) * 100
      const b = ((h + 1) / (max || 1)) * 100
      stops.push(`${c} ${a.toFixed(2)}% ${Math.min(100, b).toFixed(2)}%`)
    })
    return `linear-gradient(to right, ${stops.join(', ')})`
  }, [track, score, mode, hours, max])

  // Day ticks at local midnight; on a short trip, every 6 hours instead.
  const ticks = useMemo(() => {
    const midnights: { t: number; label: string }[] = []
    const sixes: { t: number; label: string }[] = []
    for (const t of hours) {
      const p = localParts(t, timeZone)
      if (p.hour === 0) midnights.push({ t, label: `${p.weekday} ${p.day}` })
      if (p.hour % 6 === 0) sixes.push({ t, label: p.hour === 0 ? `${p.weekday} ${p.day}` : hourLabel(p.hour) })
    }
    return midnights.length >= 2 ? midnights : sixes
  }, [hours, timeZone])

  const t = hours[hour] ?? departure
  const truck = track?.at(t)
  const cpLevel = truck && score ? levelAt(score[mode].checkpoint_levels, truck.cp) : null
  const cond = truck && score ? score.conditions[truck.cp] : undefined

  // "near Rawlins, WY" for where the truck is, once the slider settles (not every frame).
  const [near, setNear] = useState('')
  useEffect(() => {
    setNear('')
    if (!truck || playing) return
    let live = true
    const [lon, lat] = truck.pos
    const id = window.setTimeout(() => nearestPlace([lat, lon]).then((p) => live && setNear(p)), 500)
    return () => {
      live = false
      window.clearTimeout(id)
    }
  }, [hour, selected, playing, plan])

  const status = !truck
    ? ''
    : truck.status === 'before'
      ? `Leaves ${clock(departure, timeZone, false)}`
      : truck.status === 'arrived'
        ? 'Arrived'
        : truck.stop
          ? `${truck.stop.kind === 'rest' ? '10-hour rest' : '30-minute break'}${truck.stop.place ? ` at ${truck.stop.place.name}` : ''}`
          : `Driving, mile ${Math.round(truck.mile).toLocaleString('en-US')}`
  const wind = mode === 'gust' ? `gusts ${num(cond?.gust, 0, 'mph')}` : `wind ${num(cond?.wind, 0, 'mph')}`
  const onRoad = truck && truck.status !== 'before' && truck.status !== 'arrived'

  return (
    <div className="timeline" role="group" aria-label="Trip time">
      <div className="tl-top">
        <button
          type="button"
          className="play"
          onClick={() => {
            if (!playing && hourStore.get() >= max) hourStore.set(0)
            setPlaying((p) => !p)
          }}
          aria-label={playing ? 'Pause' : 'Play the trip'}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" aria-hidden><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 2.5v11l9.5-5.5z" /></svg>
          )}
        </button>
        <div className="tl-readout" aria-live="polite">
          <div className="tl-time">
            <strong>{clock(t, timeZone)}</strong>
            <span className={hour > 48 ? 'late' : 'muted'}>
              +{hour} h{hour > 48 ? ' · forecast less certain' : ''}
            </span>
          </div>
          <div className="tl-where">
            {onRoad && score && (
              <span className="chip-level" style={{ ['--c' as string]: cpLevel === null ? UNKNOWN_COLOR : LEVEL_COLORS[cpLevel] }}>
                {cpLevel === null ? 'No forecast' : LEVELS[cpLevel]}
              </span>
            )}
            <span>
              Route {route?.name}: {status}
              {near && onRoad ? ` ${near}` : ''}
              {onRoad && score ? ` · ${wind}` : ''}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="ghost small-btn"
          onClick={() => {
            setPlaying(false)
            hourStore.set(0)
          }}
          disabled={hour === 0}
          title="Back to the departure time"
        >
          Depart
        </button>
      </div>
      <div className="tl-track">
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
          aria-valuetext={`${clock(t, timeZone)}. ${status}`}
          aria-label="Trip time"
        />
        <div className="tl-strip" style={{ background: strip }} title="Risk where the truck is, hour by hour" aria-hidden />
        {route && (
          <div className="tl-events" aria-hidden>
            <span className="ev" style={{ left: pct(departure) }}>
              <Symbol id="start" size={14} title={`Depart ${clock(departure, timeZone)}`} />
            </span>
            {route.stops.map((s, i) =>
              s.kind === 'rest' ? (
                <span key={i} className="ev-rest" style={{ left: pct(s.at), width: `calc(${pct(s.at + s.duration_s)} - ${pct(s.at)})` }} title={`10-hour rest ${clock(s.at, timeZone)}`}>
                  <Symbol id={stopSymbol('rest', !!s.place)} size={14} />
                </span>
              ) : (
                <span key={i} className="ev" style={{ left: pct(s.at) }}>
                  <Symbol id={stopSymbol('break', !!s.place)} size={14} title={`30-minute break ${clock(s.at, timeZone)}`} />
                </span>
              ),
            )}
            <span className="ev" style={{ left: pct(departure + route.trip_s) }}>
              <Symbol id="end" size={14} title={`Arrive ${clock(departure + route.trip_s, timeZone)}`} />
            </span>
          </div>
        )}
        <div className="tl-ticks" aria-hidden>
          {ticks.map((k) => (
            <span key={k.t} style={{ left: pct(k.t) }}>
              {k.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
