import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type Plan, type PlanIn, type ScoreOut } from './api/client'
import ExportBar from './components/ExportBar'
import Legend from './components/Legend'
import RouteCards from './components/RouteCards'
import Sheet, { type Detent } from './components/Sheet'
import Timeline from './components/Timeline'
import TripForm from './components/TripForm'
import { clock } from './lib/format'
import { hourStore } from './lib/hourStore'
import type { WindMode } from './lib/risk'
import { BrowserWeatherUnavailable, fetchForecasts, missing } from './lib/weather'

// MapLibre is the heaviest dependency; load it in parallel with the form.
const MapView = lazy(() => import('./components/MapView'))

type Phase =
  | { kind: 'idle' }
  | { kind: 'routing' }
  | { kind: 'weather'; total: number }
  | { kind: 'heatmap'; waitingS: number } // routes are scored; heatmap cells still loading
  | { kind: 'waiting'; seconds: number } // the weather service asked us to wait
  | { kind: 'server-weather'; reason: string } // the browser could not download forecasts
  | { kind: 'scoring' }
  | { kind: 'done' }
  | { kind: 'error'; message: string; stage: 'route' | 'weather' }

const WARNINGS: Record<string, string> = {
  fewer_than_3_routes: 'Only found fewer than 3 genuinely different routes for this trip.',
  snapped_far: 'A point you picked is over a mile from the nearest road; the route starts at the closest road.',
  crosses_canada: 'A route crosses into Canada (border crossing and customs). Choose another route for a domestic load.',
  truck_routes_converge: 'Two corridors ended up on the same truck roads, so some options are near-duplicates.',
  truck_restrictions_relaxed: 'The router relaxed some truck restrictions to find a route. Check bridge heights and weight limits.',
}
const FALLBACK: Record<string, string> = {
  distance_cap: 'This trip is longer than the free truck router allows, so routes come from OSRM (car roads, truck speed capped at 65 mph).',
  valhalla_unavailable: 'The truck router is not responding, so routes come from OSRM (car roads, truck speed capped at 65 mph).',
  valhalla_slow: 'The truck router was slow, so routes come from OSRM (car roads, truck speed capped at 65 mph).',
  valhalla_disabled: 'Routes come from OSRM (car roads, truck speed capped at 65 mph).',
  valhalla_legs_failed: 'Truck routing could not finish every leg of this long trip, so routes come from OSRM (car roads, truck speed capped at 65 mph).',
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
  // Trucks are blown over by gusts, not average wind, so gusts drive the recommendation.
  const [mode, setMode] = useState<WindMode>('gust')
  // The heatmap shows the weather around the routes; it sits under the route line, faint enough not to compete.
  const [heatmapOn, setHeatmapOn] = useState(true)
  const [checkpointsOn, setCheckpointsOn] = useState(true)
  const [follow, setFollow] = useState(false)
  // Same query as the phone CSS: narrow, or narrow-ish and portrait-tall.
  const isPhone = useMedia('(max-width: 599px), (max-width: 899px) and (min-height: 501px)')
  const [detent, setDetent] = useState<Detent>('half')
  const [sheetH, setSheetH] = useState(0)
  const [serverWeather, setServerWeather] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('theme') as Theme) || 'auto'
    } catch {
      return 'auto'
    }
  })
  const systemDark = useSystemDark()
  const dark = theme === 'dark' || (theme === 'auto' && systemDark)
  useEffect(() => {
    const el = document.documentElement
    if (theme === 'auto') delete el.dataset.theme
    else el.dataset.theme = theme
    try {
      localStorage.setItem('theme', theme)
    } catch {
      // private mode: theme just won't persist
    }
  }, [theme])
  const ctrl = useRef<AbortController | null>(null)
  const lastRequest = useRef<PlanIn | null>(null)
  // A plan started in the background before the user pressed Plan (same request = reuse).
  const prefetched = useRef<{ key: string; plan: Promise<Plan> } | null>(null)

  const prefetch = useCallback((req: PlanIn) => {
    const key = JSON.stringify(req)
    if (prefetched.current?.key === key) return
    const plan = api.plan(req)
    plan.catch(() => undefined) // reported if the user actually submits it
    prefetched.current = { key, plan }
  }, [])

  // Wake the API early so a cold serverless start overlaps with the user typing.
  useEffect(() => {
    api.health().catch(() => undefined)
  }, [])

  const runWeather = useCallback(async (p: Plan, signal: AbortSignal) => {
    setPhase({ kind: 'weather', total: p.weather_points.length })
    setServerWeather(false)
    let first = true
    const show = (s: ScoreOut) => {
      setScore(s)
      setFetchedAt(Date.now())
      if (first) {
        first = false
        setSelected(s[mode].ranking.recommended ?? s[mode].ranking.order[0] ?? 0)
      }
    }
    try {
      await fetchForecasts(
        p.weather_points,
        p.checkpoint_points,
        async (weather, done) => {
          show(await api.score(p.token, weather, signal))
          setPhase(done >= p.weather_points.length ? { kind: 'done' } : { kind: 'heatmap', waitingS: 0 })
        },
        (seconds) => setPhase(first ? { kind: 'waiting', seconds } : { kind: 'heatmap', waitingS: seconds }),
        signal,
      )
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      if (e instanceof BrowserWeatherUnavailable) {
        // Fall back to downloading the forecasts from the server's own address.
        setPhase({ kind: 'server-weather', reason: e.message })
        try {
          const s = await api.score(p.token, p.weather_points.map(missing), signal, true)
          if (!s.server_weather_ok) {
            const why = s.server_weather_error || ''
            const when = /daily/i.test(why) ? 'tomorrow' : /hourly/i.test(why) ? 'within the hour' : 'in a minute'
            throw new Error(
              `${e.message} The server's weather allowance is used up too (${why || 'service unavailable'}). Try again ${when}.`,
            )
          }
          show(s)
          setServerWeather(true)
          setPhase({ kind: 'done' })
        } catch (e2) {
          if ((e2 as Error).name === 'AbortError') return
          setPhase({ kind: 'error', stage: 'weather', message: (e2 as Error).message })
        }
        return
      }
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
      const key = JSON.stringify(req)
      const early = prefetched.current?.key === key ? prefetched.current.plan : null
      const p = early ? await early : await api.plan(req, c.signal)
      if (c.signal.aborted) return
      setPlan(p)
      setSelected(0)
      setFollow(false)
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

  const longHaul = lastRequest.current ? straightKm(lastRequest.current) > 1450 : false
  const busy = phase.kind === 'routing' || phase.kind === 'weather' || phase.kind === 'scoring'
  const result = score ? score[mode] : null
  const status = result?.ranking.status
  const warnings = plan?.warnings.filter((w) => WARNINGS[w]) ?? []

  const phoneSheet = isPhone && !!plan
  const timeline = plan ? (
    <Timeline
      plan={plan}
      score={score}
      selected={selected}
      mode={mode}
    />
  ) : null
  const panelBody = (
    <>
        {!plan && (
          <p className="intro muted">Three truck routes, rated on forecast gusts, rain and snow at the hour the truck reaches each place.</p>
        )}

        {plan && !editing && (
          <div className="trip-summary">
            <div>
              <h2>
                {labels[0]} <span aria-hidden>→</span>
                <span className="sr-only"> to </span> {labels[1]}
              </h2>
              <p className="muted small">
                Leave {clock(plan.departure, plan.timezone)}
                {lastRequest.current ? ` · ${lastRequest.current.cargo_lb.toLocaleString('en-US')} lb` : ''}
              </p>
            </div>
            <button type="button" className="ghost" onClick={() => {
                setEditing(true)
                setDetent('full')
              }} disabled={busy}>
              Edit trip
            </button>
          </div>
        )}
        {plan && editing && (
          <button type="button" className="link-btn" onClick={() => setEditing(false)}>
            ← Back to the routes
          </button>
        )}
        <TripForm
          busy={busy}
          folded={!!plan && !editing}
          onSubmit={(req, names) => {
            setEditing(false)
            setDetent('half')
            void start(req, names)
          }}
          onCancel={cancel}
          onPrefetch={prefetch}
        />

        <section className="results" aria-live="polite" aria-busy={busy}>
          {phase.kind === 'routing' && (
            <Progress text={longHaul ? 'Long trip: truck-routing each corridor in legs (about 15–30 s)…' : 'Finding three routes…'} />
          )}
          {phase.kind === 'weather' && <Progress text={`Fetching forecasts for ${phase.total} locations…`} />}
          {phase.kind === 'waiting' && <Countdown seconds={phase.seconds} />}
          {phase.kind === 'server-weather' && (
            <Progress text={`${phase.reason} Fetching the forecasts from the server instead…`} />
          )}
          {phase.kind === 'heatmap' && (
            <p className="notice info">
              Routes are scored. The heatmap needs more forecasts than the weather service allows per minute,
              so it will appear {phase.waitingS ? `in about ${phase.waitingS} s` : 'shortly'}.
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
              <p className="freshness">
                {plan.router.provider === 'valhalla'
                  ? `Truck routes from Valhalla${(plan.router.legs ?? 1) > 1 ? ` (${plan.router.legs} legs)` : ''}`
                  : 'Car routes from OSRM'}
                {fetchedAt && score
                  ? `. Forecast from Open-Meteo${serverWeather ? ' via the server' : ''} at ${new Date(fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}, rated on ${mode === 'gust' ? 'gusts' : 'sustained wind'}.`
                  : '.'}
              </p>
              {plan.router.fallback_reason && <p className="notice info">{FALLBACK[plan.router.fallback_reason]}</p>}
              {warnings.map((w) => (
                <p key={w} className="notice info">
                  {WARNINGS[w]}
                </p>
              ))}
              {status && status !== 'ok' && <p className="notice warn">{STATUS[status]}</p>}
              <RouteCards
                plan={plan}
                score={score}
                mode={mode}
                result={result}
                weatherFailed={phase.kind === 'error' && phase.stage === 'weather'}
                selected={selected}
                onSelect={setSelected}
              />
              <ExportBar plan={plan} selected={selected} labels={labels} />
              <details className="section">
                <summary>How routes are ranked</summary>
                <p className="small">
                  Each checkpoint is rated at the truck’s estimated arrival time and stands for the road halfway to its
                  neighbours. Routes that stay in the US come first, then the fewest No Travel, Severe and High miles,
                  then the lowest average risk, then the shortest trip. Missing forecasts count as No Travel when
                  ranking, so a gap can never make a route look safer.
                </p>
              </details>
            </>
          )}
          {!plan && phase.kind === 'idle' && (
            <p className="empty muted">Pick a trip above, or try one of the examples.</p>
          )}
        </section>

        <footer className="credits muted">
          <details>
            <summary>
              Data: OpenStreetMap, Valhalla, OSRM, Open-Meteo, Photon, U.S. DOT
            </summary>
            Routes © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> via{' '}
            <a href="https://valhalla.openstreetmap.de">FOSSGIS Valhalla</a> and{' '}
            <a href="https://project-osrm.org">OSRM</a> (
            <a href="https://www.openstreetmap.org/fixthemap">fix the map</a>). Weather by{' '}
            <a href="https://open-meteo.com/">Open-Meteo.com</a> (CC BY 4.0). Places by{' '}
            <a href="https://photon.komoot.io">Photon</a>. Truck parking: OpenStreetMap (ODbL) and U.S. DOT BTS NTAD
            Truck Stop Parking (2019). Non-commercial demo; places you type are sent to these services.
            {import.meta.env.VITE_OPERATOR_EMAIL && (
              <>
                {' '}Contact: <a href={`mailto:${import.meta.env.VITE_OPERATOR_EMAIL}`}>{import.meta.env.VITE_OPERATOR_EMAIL}</a>.
              </>
            )}
          </details>
        </footer>
    </>
  )

  return (
    <div
      className={`app${plan ? ' has-plan' : ''}${phoneSheet ? ' phone-sheet' : ''}`}
      style={phoneSheet ? ({ '--sheet-h': `${sheetH}px` } as React.CSSProperties) : undefined}
    >
      <header className="brand">
        <svg viewBox="0 0 32 32" aria-hidden className="logo">
          <rect width="32" height="32" rx="8" />
          <path d="M7 21h14v-8h4l3 4v4h-2" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
          <circle cx="11" cy="22" r="2" fill="#fff" />
          <circle cx="23" cy="22" r="2" fill="#fff" />
        </svg>
        <h1>Weather-aware truck routing</h1>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto')}
          title="Colour theme: Auto follows your device"
        >
          {theme === 'auto' ? 'Auto' : theme === 'dark' ? 'Dark' : 'Light'}
        </button>
      </header>
      {phoneSheet ? (
        <Sheet head={timeline} detent={detent} onDetent={setDetent} onHeight={setSheetH} top={54}>
          {panelBody}
        </Sheet>
      ) : (
        <aside className="panel">{panelBody}</aside>
      )}

      <main className="stage">
        <Suspense fallback={<div className="map map-loading" />}>
          <MapView
            plan={plan}
            score={score}
            mode={mode}
            selected={selected}
            labels={labels}
            heatmapOn={heatmapOn}
            checkpointsOn={checkpointsOn}
            follow={follow}
            onFollow={setFollow}
            onSelect={setSelected}
            onMode={setMode}
            onHeatmap={setHeatmapOn}
            onCheckpoints={setCheckpointsOn}
            dark={dark}
            bottomInset={phoneSheet ? sheetH : 0}
          />
        </Suspense>
        {plan && <Legend mode={mode} />}
        {plan && !phoneSheet && timeline}
      </main>
    </div>
  )
}

type Theme = 'auto' | 'light' | 'dark'

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia?.(query).matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const fn = (e: MediaQueryListEvent) => setOn(e.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [query])
  return on
}

function useSystemDark(): boolean {
  const query = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(() => window.matchMedia?.(query).matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const on = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

function straightKm(r: PlanIn): number {
  const rad = Math.PI / 180
  const a = r.origin, b = r.destination
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

function Countdown({ seconds }: { seconds: number }) {
  const [left, setLeft] = useState(seconds)
  useEffect(() => {
    setLeft(seconds)
    const t = window.setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearInterval(t)
  }, [seconds])
  return (
    <Progress
      text={`The weather service limits requests per minute (a long trip was just planned from this network). Continuing in ${left} s…`}
      value={1 - left / Math.max(1, seconds)}
    />
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
