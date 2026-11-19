import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type Plan, type PlanIn, type ScoreOut } from './api/client'
import Legend from './components/Legend'
import RouteCards from './components/RouteCards'
import Timeline from './components/Timeline'
import TripForm from './components/TripForm'
import { hourStore } from './lib/hourStore'
import type { WindMode } from './lib/risk'
import { fetchForecasts } from './lib/weather'

// MapLibre is the heaviest dependency; load it in parallel with the form.
const MapView = lazy(() => import('./components/MapView'))

type Phase =
  | { kind: 'idle' }
  | { kind: 'routing' }
  | { kind: 'weather'; total: number }
  | { kind: 'heatmap'; waitingS: number } // routes are scored; heatmap cells still loading
  | { kind: 'scoring' }
  | { kind: 'done' }
  | { kind: 'error'; message: string; stage: 'route' | 'weather' }

const WARNINGS: Record<string, string> = {
  fewer_than_3_routes: 'Only found fewer than 3 genuinely different routes for this trip.',
  snapped_far: 'A point you picked is over a mile from the nearest road; the route starts at the closest road.',
  crosses_canada: 'A route crosses into Canada (border crossing and customs). Choose another route for a domestic load.',
  truck_restrictions_relaxed: 'The router relaxed some truck restrictions to find a route. Check bridge heights and weight limits.',
}
const FALLBACK: Record<string, string> = {
  distance_cap: 'This trip is longer than the free truck router allows, so routes come from OSRM (car roads, truck speed capped at 65 mph).',
  valhalla_unavailable: 'The truck router is not responding, so routes come from OSRM (car roads, truck speed capped at 65 mph).',
  valhalla_slow: 'The truck router was slow, so routes come from OSRM (car roads, truck speed capped at 65 mph).',
  valhalla_disabled: 'Routes come from OSRM (car roads, truck speed capped at 65 mph).',
}
const STATUS: Record<string, string> = {
  all_no_travel: 'No route is safe to dispatch at this time: every option has No Travel miles. Try a later departure.',
  weather_incomplete: 'The forecast is missing for part of a route, and that could change the answer, so nothing is recommended.',
  no_weather: 'No forecast is available for this trip, so nothing is recommended.',
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [plan, setPlan] = useState<Plan | null>(null)
  const [score, setScore] = useState<ScoreOut | null>(null)
  const [labels, setLabels] = useState<[string, string]>(['', ''])
  const [selected, setSelected] = useState(0)
  const [mode, setMode] = useState<WindMode>('sustained')
  const [heatmapOn, setHeatmapOn] = useState(true)
  const ctrl = useRef<AbortController | null>(null)
  const lastRequest = useRef<PlanIn | null>(null)

  // Wake the API early so a cold serverless start overlaps with the user typing.
  useEffect(() => {
    api.health().catch(() => undefined)
  }, [])

  const runWeather = useCallback(async (p: Plan, signal: AbortSignal) => {
    setPhase({ kind: 'weather', total: p.weather_points.length })
    let first = true
    try {
      await fetchForecasts(
        p.weather_points,
        p.checkpoint_points,
        async (weather, done) => {
          const s = await api.score(p.token, weather, signal)
          setScore(s)
          if (first) {
            first = false
            setSelected(s[mode].ranking.recommended ?? s[mode].ranking.order[0] ?? 0)
          }
          setPhase(done >= p.weather_points.length ? { kind: 'done' } : { kind: 'heatmap', waitingS: 0 })
        },
        (waitingS) => setPhase({ kind: 'heatmap', waitingS }),
        signal,
      )
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setPhase({ kind: 'error', stage: 'weather', message: (e as Error).message })
    }
  }, [mode])

  const start = async (req: PlanIn, names: [string, string]) => {
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    lastRequest.current = req
    setLabels(names)
    setPhase({ kind: 'routing' })
    setScore(null)
    hourStore.set(0)
    try {
      const p = await api.plan(req, c.signal)
      setPlan(p)
      setSelected(0)
      await runWeather(p, c.signal)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      const msg = e instanceof ApiError ? e.message : 'Something went wrong while planning.'
      setPhase({ kind: 'error', stage: 'route', message: msg })
    }
  }

  const cancel = () => {
    ctrl.current?.abort()
    setPhase({ kind: 'idle' })
  }

  const retry = () => {
    if (phase.kind !== 'error') return
    if (phase.stage === 'weather' && plan) {
      const c = new AbortController()
      ctrl.current = c
      void runWeather(plan, c.signal)
    } else if (lastRequest.current) {
      void start(lastRequest.current, labels)
    }
  }

  const busy = phase.kind === 'routing' || phase.kind === 'weather' || phase.kind === 'scoring'
  const result = score ? score[mode] : null
  const status = result?.ranking.status
  const warnings = plan?.warnings.filter((w) => WARNINGS[w]) ?? []

  return (
    <div className="app">
      <aside className="panel">
        <header className="brand">
          <svg viewBox="0 0 32 32" aria-hidden className="logo">
            <rect width="32" height="32" rx="8" />
            <path d="M7 21h14v-8h4l3 4v4h-2" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
            <circle cx="11" cy="22" r="2" fill="#fff" />
            <circle cx="23" cy="22" r="2" fill="#fff" />
          </svg>
          <div>
            <h1>Weather-aware truck routing</h1>
            <p className="muted">Three routes, scored on forecast wind, rain and snow at the truck’s arrival time.</p>
          </div>
        </header>

        <TripForm busy={busy} onSubmit={start} onCancel={cancel} />

        <section className="results" aria-live="polite" aria-busy={busy}>
          {phase.kind === 'routing' && <Progress text="Finding three routes…" />}
          {phase.kind === 'weather' && <Progress text={`Fetching forecasts for ${phase.total} locations…`} />}
          {phase.kind === 'heatmap' && (
            <p className="notice info">
              Routes are scored. The heatmap needs more forecasts than the weather service allows per minute,
              so it fills in{phase.waitingS ? ` in about ${phase.waitingS} s` : ' shortly'}.
            </p>
          )}
          {phase.kind === 'scoring' && <Progress text="Scoring routes…" />}
          {phase.kind === 'error' && (
            <div className="notice error" role="alert">
              <p>{phase.message}</p>
              <button type="button" className="ghost" onClick={retry}>
                Try again
              </button>
            </div>
          )}

          {plan && (
            <>
              <div className="trip-summary">
                <h2>
                  {labels[0]} <span aria-hidden>→</span>
                  <span className="sr-only"> to </span> {labels[1]}
                </h2>
                <span className={`router ${plan.router.provider}`} title="Which routing service answered">
                  {plan.router.provider === 'valhalla' ? 'Truck routing · Valhalla' : 'Car routing · OSRM'}
                </span>
              </div>
              {plan.router.fallback_reason && <p className="notice info">{FALLBACK[plan.router.fallback_reason]}</p>}
              {warnings.map((w) => (
                <p key={w} className="notice info">
                  {WARNINGS[w]}
                </p>
              ))}
              {status && status !== 'ok' && <p className="notice warn">{STATUS[status]}</p>}
              <RouteCards plan={plan} result={result} selected={selected} onSelect={setSelected} />
              <p className="footnote muted">
                Risk is rated at each checkpoint, at the truck’s estimated arrival time, and each checkpoint counts for
                the road halfway to its neighbours. Ranking: US-only routes first, then fewest No Travel, Severe and High miles,
                then lowest average risk, then shortest time.
              </p>
            </>
          )}
          {!plan && phase.kind === 'idle' && (
            <p className="empty muted">Pick a trip above, or try one of the examples.</p>
          )}
        </section>

        <footer className="credits muted">
          Routes © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> via{' '}
          <a href="https://valhalla.openstreetmap.de">FOSSGIS Valhalla</a> and{' '}
          <a href="https://project-osrm.org">OSRM</a> (
          <a href="https://www.openstreetmap.org/fixthemap">fix the map</a>). Weather by{' '}
          <a href="https://open-meteo.com/">Open-Meteo.com</a> (CC BY 4.0). Places by{' '}
          <a href="https://photon.komoot.io">Photon</a>. Non-commercial demo; places you type are sent to these services.
          {import.meta.env.VITE_OPERATOR_EMAIL && (
            <>
              {' '}Contact: <a href={`mailto:${import.meta.env.VITE_OPERATOR_EMAIL}`}>{import.meta.env.VITE_OPERATOR_EMAIL}</a>.
            </>
          )}
        </footer>
      </aside>

      <main className="stage">
        <Suspense fallback={<div className="map map-loading" />}>
          <MapView plan={plan} score={score} mode={mode} selected={selected} heatmapOn={heatmapOn} onSelect={setSelected} />
        </Suspense>
        <Legend />
        {plan && (
          <Timeline
            hours={plan.hours}
            departure={plan.departure}
            timeZone={plan.timezone}
            mode={mode}
            onMode={setMode}
            heatmapOn={heatmapOn}
            onHeatmap={setHeatmapOn}
          />
        )}
      </main>
    </div>
  )
}

function Progress({ text, value }: { text: string; value?: number }) {
  return (
    <div className="progress">
      <span>{text}</span>
      <div className="track">
        <div className={value === undefined ? 'fill indeterminate' : 'fill'} style={value === undefined ? undefined : { width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  )
}
