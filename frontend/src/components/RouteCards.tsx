import { useEffect, useState } from 'react'
import type { ModeResult, Plan, ScoreOut } from '../api/client'
import { clock, duration, miles } from '../lib/format'
import { LEVEL_COLORS, LEVELS, UNKNOWN_COLOR, type WindMode } from '../lib/risk'
import { hazardSymbol } from '../lib/symbols'
import { nearestPlace, verdictFor } from '../lib/verdict'
import Symbol from './Symbol'

interface Props {
  plan: Plan
  score: ScoreOut | null
  mode: WindMode
  result: ModeResult | null
  /** Weather could not be fetched: say so instead of showing a loading bar forever. */
  weatherFailed?: boolean
  selected: number
  onSelect: (id: number) => void
}

function VerdictLine({ plan, score, mode, routeId }: { plan: Plan; score: ScoreOut; mode: WindMode; routeId: number }) {
  const v = verdictFor(plan, score, mode, routeId)
  const [near, setNear] = useState('')
  useEffect(() => {
    let live = true
    setNear('')
    if (v.point) nearestPlace(v.point).then((p) => live && setNear(p))
    return () => {
      live = false
    }
  }, [v.point?.[0], v.point?.[1]])
  if (v.level === null) return null
  const sym = hazardSymbol(v.level)
  return (
    <div className={`verdict lvl${v.level}`}>
      <span className="verdict-icon" aria-hidden>
        {sym ? <Symbol id={sym} size={20} /> : <i className="level-dot" style={{ background: LEVEL_COLORS[v.level] }} />}
      </span>
      <div>
        <strong>
          {v.level > 0 && `${LEVELS[v.level]}: `}
          {v.hazard}
        </strong>
        {(near || v.when) && <div className="verdict-where">{[near, v.when].filter(Boolean).join(' · ')}</div>}
        {v.level > 1 && <div className="verdict-action">{v.action}</div>}
      </div>
    </div>
  )
}

export default function RouteCards({ plan, score, mode, result, weatherFailed, selected, onSelect }: Props) {
  const routes = plan.routes.features.map((f) => f.properties)
  const order = result?.ranking.order ?? routes.map((r) => r.id)
  const shortest = Math.min(...routes.map((r) => r.distance_mi))
  return (
    <ol className="cards" aria-label="Route options, best first">
      {order.map((id) => {
        const r = routes[id]
        if (!r) return null
        const s = result?.routes.find((x) => x.id === id)
        const recommended = result?.ranking.recommended === id
        const reason = result?.ranking.reasons[id]
        const noTravel = (s?.miles_by_level[4] ?? 0) > 0
        const canada = r.warnings?.includes('crosses_canada')
        const extra = Math.round(r.distance_mi - shortest)
        // One badge, most important first.
        const badge = recommended
          ? <span className="badge good">Recommended</span>
          : noTravel
            ? <span className="badge bad">No Travel miles</span>
            : canada
              ? <span className="badge warnb" title="Leaves the US through Canada: border crossing and customs">Via Canada</span>
              : null
        const risky = s ? [4, 3, 2].filter((lvl) => (s.miles_by_level[lvl] ?? 0) > 0) : []
        return (
          <li key={id}>
            <button
              type="button"
              className={`card${selected === id ? ' selected' : ''}`}
              onClick={() => onSelect(id)}
              aria-pressed={selected === id}
            >
              <div className="card-head">
                <span className="route-name">Route {r.name}</span>
                {extra > 0 && <span className="muted card-extra">+{extra.toLocaleString('en-US')} mi</span>}
                {badge}
              </div>
              {score && <VerdictLine plan={plan} score={score} mode={mode} routeId={id} />}
              <dl className="card-stats">
                <div>
                  <dt>Distance</dt>
                  <dd>{miles(r.distance_mi)}</dd>
                </div>
                <div>
                  <dt>Driving</dt>
                  <dd>{duration(r.drive_s)}</dd>
                </div>
                <div>
                  <dt>Arrive</dt>
                  <dd title={r.trip_s > r.drive_s + 60 ? `${duration(r.trip_s)} door to door, with required rest` : undefined}>
                    {clock(plan.departure + r.trip_s, plan.timezone)}
                  </dd>
                </div>
              </dl>
              {s ? (
                <>
                  <div className="bar" role="img" aria-label={barLabel(s.miles_by_level, s.unknown_mi)}>
                    {s.miles_by_level.map((m, lvl) =>
                      m > 0 ? <span key={lvl} style={{ flexGrow: m, background: LEVEL_COLORS[lvl] }} /> : null,
                    )}
                    {s.unknown_mi > 0 && <span style={{ flexGrow: s.unknown_mi, background: UNKNOWN_COLOR }} />}
                  </div>
                  <div className="card-risk">
                    {risky.map((lvl) => (
                      <span key={lvl}>
                        <i style={{ background: LEVEL_COLORS[lvl] }} />
                        {miles(s.miles_by_level[lvl] ?? 0)} {LEVELS[lvl]}
                      </span>
                    ))}
                    {s.unknown_mi > 0 && (
                      <span>
                        <i style={{ background: UNKNOWN_COLOR }} />
                        {miles(s.unknown_mi)} no forecast
                      </span>
                    )}
                    {!risky.length && !s.unknown_mi && <span className="muted">No High, Severe or No Travel miles</span>}
                  </div>
                  {reason && selected === id && <p className="reason">{reason}</p>}
                </>
              ) : weatherFailed ? (
                <p className="reason">No forecast yet, so this route is not rated. Try again in a minute.</p>
              ) : (
                <div className="bar loading" aria-hidden />
              )}
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function barLabel(byLevel: number[], unknown: number): string {
  const parts = byLevel.map((m, i) => (m > 0 ? `${Math.round(m)} miles ${LEVELS[i]}` : '')).filter(Boolean)
  if (unknown > 0) parts.push(`${Math.round(unknown)} miles without forecast`)
  return `Risk by distance: ${parts.join(', ')}`
}
