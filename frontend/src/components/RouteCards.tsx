import { useEffect, useState } from 'react'
import type { ModeResult, Plan, ScoreOut } from '../api/client'
import { clock, duration, miles } from '../lib/format'
import { LEVEL_COLORS, LEVELS, UNKNOWN_COLOR, type WindMode } from '../lib/risk'
import { nearestPlace, verdictFor } from '../lib/verdict'

interface Props {
  plan: Plan
  score: ScoreOut | null
  mode: WindMode
  result: ModeResult | null
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
  const color = v.level > 0 ? LEVEL_COLORS[v.level] : undefined
  return (
    <div className={`verdict lvl${v.level}`} style={color ? { borderColor: color } : undefined}>
      <strong>
        {v.level > 0 && <span className="verdict-level">{LEVELS[v.level]}:</span>} {v.hazard}
      </strong>
      {(near || v.when) && (
        <span className="verdict-where">
          {[near, v.when].filter(Boolean).join(' · ')}
        </span>
      )}
      {v.level > 0 && <span className="verdict-action">{v.action}</span>}
    </div>
  )
}

export default function RouteCards({ plan, score, mode, result, selected, onSelect }: Props) {
  const routes = plan.routes.features.map((f) => f.properties)
  const order = result?.ranking.order ?? routes.map((r) => r.id)
  return (
    <ol className="cards" aria-label="Route options, best first">
      {order.map((id, rank) => {
        const r = routes[id]
        if (!r) return null
        const s = result?.routes.find((x) => x.id === id)
        const recommended = result?.ranking.recommended === id
        const reason = result?.ranking.reasons[id]
        const noTravel = (s?.miles_by_level[4] ?? 0) > 0
        const total = s ? s.miles_by_level.reduce((a, b) => a + b, 0) + s.unknown_mi : 0
        return (
          <li key={id}>
            <button
              type="button"
              className={`card${selected === id ? ' selected' : ''}${recommended ? ' recommended' : ''}`}
              onClick={() => onSelect(id)}
              aria-pressed={selected === id}
            >
              <div className="card-head">
                <span className="route-name">Route {r.name}</span>
                {recommended && <span className="badge good">Recommended</span>}
                {!recommended && noTravel && <span className="badge bad">No Travel segment</span>}
                {result && !recommended && !noTravel && <span className="badge">#{rank + 1}</span>}
                {r.via && <span className="badge subtle" title="Found by routing through a side point">detour</span>}
                {r.warnings?.includes('crosses_canada') && (
                  <span className="badge warnb" title="Leaves the US through Canada: border crossing and customs">via Canada</span>
                )}
              </div>
              {score && <VerdictLine plan={plan} score={score} mode={mode} routeId={id} />}
              <div className="card-stats">
                <span>{miles(r.distance_mi)}</span>
                <span title="Driving time">{duration(r.drive_s)} driving</span>
                {r.trip_s > r.drive_s + 60 && <span title="Including required rest stops">{duration(r.trip_s)} total</span>}
              </div>
              <div className="card-eta">Arrives {clock(plan.departure + r.trip_s, plan.timezone)}</div>
              {s ? (
                <>
                  <div className="bar" role="img" aria-label={barLabel(s.miles_by_level, s.unknown_mi)}>
                    {s.miles_by_level.map((m, lvl) =>
                      m > 0 ? <span key={lvl} style={{ flexGrow: m, background: LEVEL_COLORS[lvl] }} /> : null,
                    )}
                    {s.unknown_mi > 0 && <span className="unknown" style={{ flexGrow: s.unknown_mi, background: UNKNOWN_COLOR }} />}
                  </div>
                  <div className="card-risk">
                    {[4, 3, 2].map((lvl) =>
                      (s.miles_by_level[lvl] ?? 0) > 0 ? (
                        <span key={lvl}>
                          <i style={{ background: LEVEL_COLORS[lvl] }} />
                          {miles(s.miles_by_level[lvl] ?? 0)} {LEVELS[lvl]}
                        </span>
                      ) : null,
                    )}
                    {s.unknown_mi > 0 && (
                      <span>
                        <i style={{ background: UNKNOWN_COLOR }} />
                        {miles(s.unknown_mi)} no forecast
                      </span>
                    )}
                    {total > 0 && (s.miles_by_level[2] ?? 0) + (s.miles_by_level[3] ?? 0) + (s.miles_by_level[4] ?? 0) + s.unknown_mi === 0 && (
                      <span>No High, Severe or No Travel miles</span>
                    )}
                    <span className="muted">avg risk {s.avg_risk === null ? '—' : s.avg_risk.toFixed(2)}</span>
                  </div>
                  {reason && <p className="reason">{reason}</p>}
                </>
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
