// The trip clock: drag or play through time and watch the truck drive the forecast.
//
// Under the slider, a strip shows the risk the truck itself meets each hour (not the
// worst anywhere), and an event row shows departure, breaks, rests and arrival with the
// same symbols as the map. Moving the slider writes hourStore; the map repaints at most
// once per frame and the rest of the app does not re-render.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Plan, ScoreOut } from '../api/client'
import { clock, num } from '../lib/format'
import { hourStore, timeAt, usePlayhead } from '../lib/hourStore'
import { LEVEL_COLORS, LEVELS, UNKNOWN_COLOR, levelAt, type WindMode } from '../lib/risk'
import { stopSymbol } from '../lib/symbols'
import { camera } from '../lib/camera'
import { createTrack } from '../lib/track'
import { nearestPlace } from '../lib/verdict'
import Symbol from './Symbol'

interface Props {
  plan: Plan
  score: ScoreOut | null
  selected: number
  mode: WindMode
}

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

/** "+2 h 15 m" since departure, "-0 h 45 m" before it. */
function elapsed(s: number) {
  const m = Math.round(Math.abs(s) / 300) * 5
  const h = Math.floor(m / 60)
  return `${s < 0 ? '−' : '+'}${h} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')} m` : ''}`
}

function hourLabel(h: number) {
  return h === 0 ? '12 AM' : h === 12 ? 'Noon' : h < 12 ? `${h} AM` : `${h - 12} PM`
}

export default function Timeline({ plan, score, selected, mode }: Props) {
  const playhead = usePlayhead()
  const hour = Math.floor(playhead)
  const [playing, setPlaying] = useState(false)
  const raf = useRef(0)
  const pending = useRef(0) // a play waiting for the camera to frame the trip
  const input = useRef<HTMLInputElement>(null)
  const { hours, departure, timezone: timeZone } = plan
  const max = hours.length - 1
  const track = useMemo(() => createTrack(plan, selected), [plan, selected])
  const route = plan.routes.features[selected]?.properties
  const t0 = hours[0] ?? departure

  // The slider spans the trip (the latest arrival of any route, so switching routes
  // keeps the scale) unless the user asks for the full forecast window the heatmap covers.
  const tripEnd = Math.max(...plan.routes.features.map((f) => departure + f.properties.trip_s))
  const tripMax = Math.min(max, Math.ceil((tripEnd - t0) / 3600) + 1)
  const canWiden = max - tripMax >= 3
  const [wide, setWide] = useState(false)
  const viewMax = wide && canWiden ? max : tripMax
  const viewRef = useRef(viewMax)
  viewRef.current = viewMax
  useEffect(() => {
    if (hourStore.get() > viewMax) hourStore.set(viewMax)
  }, [viewMax])

  // Keep the thumb in step with the playhead every frame without re-rendering React.
  useEffect(() => {
    const sync = () => {
      if (input.current && document.activeElement !== input.current) input.current.value = String(hourStore.get())
    }
    sync()
    return hourStore.subscribe(sync)
  }, [viewMax])

  // Continuous playback: the playhead advances a little every frame, so the truck drives
  // instead of hopping an hour at a time. Breaks and rests play faster (nothing moves).
  useEffect(() => {
    if (!playing || !track) return
    const rate = Math.min(6, Math.max(1.2, viewMax / 16)) // trip hours per second
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000) // a stalled tab must not leap ahead
      last = now
      const h = hourStore.get()
      const status = track.at(timeAt(hours, h)).status
      const next = h + dt * rate * (status === 'driving' ? 1 : 4)
      if (next >= viewRef.current) {
        hourStore.set(viewRef.current)
        setPlaying(false)
        return
      }
      hourStore.set(next)
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    const stop = () => document.hidden && setPlaying(false)
    document.addEventListener('visibilitychange', stop)
    return () => {
      cancelAnimationFrame(raf.current)
      document.removeEventListener('visibilitychange', stop)
    }
  }, [playing, track, hours, viewMax])

  const span = Math.max(1, viewMax) * 3600
  const pct = (t: number) => `${Math.max(0, Math.min(100, ((t - t0) / span) * 100))}%`

  // What the truck meets each hour, as one CSS gradient (cheap for hundreds of hours).
  const strip = useMemo(() => {
    if (!track || !score) return undefined
    const levels = score[mode].checkpoint_levels
    const stops: string[] = []
    for (let h = 0; h < viewMax; h++) {
      const s = track.at(timeAt(hours, h + 0.5))
      const l = levelAt(levels, s.cp)
      const c = s.status === 'before' || s.status === 'arrived' ? 'transparent' : l === null ? UNKNOWN_COLOR : LEVEL_COLORS[l]
      stops.push(`${c} ${((h / viewMax) * 100).toFixed(2)}% ${(((h + 1) / viewMax) * 100).toFixed(2)}%`)
    }
    return `linear-gradient(to right, ${stops.join(', ')})`
  }, [track, score, mode, hours, viewMax])

  // Day ticks at local midnight; on a short view, every 6 hours instead.
  const ticks = useMemo(() => {
    const midnights: { t: number; label: string }[] = []
    const sixes: { t: number; label: string }[] = []
    for (const t of hours.slice(0, viewMax + 1)) {
      const p = localParts(t, timeZone)
      if (p.hour === 0) midnights.push({ t, label: `${p.weekday} ${p.day}` })
      if (p.hour % 6 === 0) sixes.push({ t, label: p.hour === 0 ? `${p.weekday} ${p.day}` : hourLabel(p.hour) })
    }
    return midnights.length >= 3 ? midnights : sixes
  }, [hours, timeZone, viewMax])

  const t = timeAt(hours, playhead)
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
  }, [playhead, selected, playing, plan])

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

  const seek = (h: number) => {
    window.clearTimeout(pending.current)
    setPlaying(false)
    hourStore.set(Math.max(0, Math.min(viewMax, h)))
  }

  return (
    <div className="timeline" role="group" aria-label="Trip time">
      <div className="tl-top">
        <button
          type="button"
          className="play"
          onClick={() => {
            window.clearTimeout(pending.current)
            if (playing) return setPlaying(false)
            if (hourStore.get() >= viewMax - 0.01) hourStore.set(0)
            const wait = camera.beforePlay()
            if (wait > 0) pending.current = window.setTimeout(() => setPlaying(true), wait)
            else setPlaying(true)
          }}
          aria-label={playing ? 'Pause' : 'Play the trip'}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" aria-hidden><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 2.5v11l9.5-5.5z" /></svg>
          )}
        </button>
        <div className="tl-readout" aria-live={playing ? 'off' : 'polite'}>
          <div className="tl-time">
            <strong>{clock(t, timeZone)}</strong>
            <span className={hour >= 48 ? 'late' : 'muted'}>
              {elapsed(t - departure)}
              {hour >= 48 ? ' · forecast less certain' : ''}
            </span>
          </div>
          <div className="tl-where">
            {onRoad && score && (
              <span className="chip-level" style={{ ['--c' as string]: cpLevel === null ? UNKNOWN_COLOR : LEVEL_COLORS[cpLevel] }}>
                {cpLevel === null ? 'No forecast' : LEVELS[cpLevel]}
              </span>
            )}
            <span>
              <span className="tl-route">Route {route?.name}: </span>
              {status}
              {near && onRoad ? ` ${near}` : ''}
              {onRoad && score ? ` · ${wind}` : ''}
            </span>
          </div>
        </div>
        <div className="tl-actions">
          {canWiden && (
            <button type="button" className={`ghost small-btn wide-toggle${wide ? ' on' : ''}`} aria-pressed={wide} onClick={() => setWide((w) => !w)} title="Show the full forecast window the heatmap covers">
              {max} h
            </button>
          )}
          {canWiden && (
            <div className="seg small wide-seg" role="radiogroup" aria-label="Timeline length">
              <button type="button" role="radio" aria-checked={!wide} className={!wide ? 'on' : undefined} onClick={() => setWide(false)} title="Fit the slider to this trip">
                Trip
              </button>
              <button type="button" role="radio" aria-checked={wide} className={wide ? 'on' : undefined} onClick={() => setWide(true)} title="The full forecast window the heatmap covers">
                {max} h
              </button>
            </div>
          )}
          <button type="button" className="ghost small-btn depart" onClick={() => seek(0)} disabled={playhead === 0 && !playing} title="Back to the departure time" aria-label="Back to departure">
            <svg viewBox="0 0 16 16" aria-hidden><path d="M3 3v10M13 3.5 6 8l7 4.5z" /></svg>
            <span>Depart</span>
          </button>
        </div>
      </div>
      <div className="tl-track">
        <input
          ref={input}
          type="range"
          min={0}
          max={viewMax}
          step="any"
          defaultValue={0}
          onInput={(e) => seek(Number((e.target as HTMLInputElement).value))}
          onKeyDown={(e) => {
            const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 6, PageDown: -6 }[e.key]
            if (d === undefined) return
            e.preventDefault()
            seek(Math.round(hourStore.get()) + d)
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
