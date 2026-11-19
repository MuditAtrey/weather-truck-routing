// The trip itinerary: where to stop, when, and links that open each leg in the app the
// driver uses. Every link format here was checked in a browser for what it really does.
import { useState } from 'react'
import type { Plan } from '../api/client'
import {
  appleTripUrl,
  downloadGpx,
  googleDayLinks,
  itineraryText,
  legLinks,
  legs,
  STOP_NAME,
  stopsOf,
} from '../lib/export'
import { clock } from '../lib/format'

interface Props {
  plan: Plan
  selected: number
  labels: [string, string]
}

const KIND = { truck_stop: 'Truck stop', public: 'Rest area', truck_parking: 'Truck parking' } as const

export default function ExportBar({ plan, selected, labels }: Props) {
  const [copied, setCopied] = useState(false)
  const route = plan.routes.features[selected]
  if (!route) return null
  const stops = stopsOf(route)
  const legList = legs(route, labels)
  const days = googleDayLinks(route, labels)
  const t = (s: number) => clock(s, plan.timezone)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(itineraryText(plan, route, labels, t))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const LegLinks = ({ i }: { i: number }) => {
    const leg = legList[i]
    if (!leg) return null
    const l = legLinks(leg)
    return (
      <span className="leg-links" aria-label={`Navigate to ${leg.toLabel}`}>
        <a href={l.google} target="_blank" rel="noreferrer">Google</a>
        <a href={l.apple} target="_blank" rel="noreferrer">Apple</a>
        <a href={l.waze} target="_blank" rel="noreferrer">Waze</a>
      </span>
    )
  }

  return (
    <section className="export" aria-label={`Route ${route.properties.name} itinerary`}>
      <h3>Route {route.properties.name} itinerary</h3>
      <ol className="itinerary">
        <li>
          <span className="it-dot start" aria-hidden />
          <div>
            <strong>{labels[0]}</strong>
            <div className="muted">Leave {t(plan.departure)}</div>
          </div>
        </li>
        {stops.map((s, i) => (
          <li key={i}>
            <span className={`it-dot ${s.kind}`} aria-hidden />
            <div>
              <strong>{STOP_NAME[s.kind]}</strong>{' '}
              {s.place ? (
                <>
                  at {s.place.name}
                  <div className="muted">
                    {KIND[s.place.kind]}
                    {s.place.road ? ` · ${s.place.road}` : ''}
                    {s.place.spaces ? ` · ${s.place.spaces} truck spaces` : ' · spaces unknown'}
                    {s.place.off_route_mi >= 0.3 ? ` · ${s.place.off_route_mi} mi off route` : ''}
                  </div>
                </>
              ) : (
                <div className="warn-text">No known truck parking before the limit here. Plan parking ahead.</div>
              )}
              <div className="muted">
                Mile {Math.round(s.mile).toLocaleString('en-US')} · {t(s.at)}
                {s.early_min >= 45 ? ` · ${Math.round(s.early_min / 6) / 10} h before the limit (next parking is past it)` : ''}
              </div>
              <LegLinks i={i} />
            </div>
          </li>
        ))}
        <li>
          <span className="it-dot end" aria-hidden />
          <div>
            <strong>{labels[1]}</strong>
            <div className="muted">Arrive {t(plan.departure + route.properties.trip_s)}</div>
            <LegLinks i={legList.length - 1} />
          </div>
        </li>
      </ol>
      <div className="export-actions">
        <button type="button" className="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy itinerary'}</button>
        <button type="button" className="ghost" onClick={() => downloadGpx(plan, route, labels)}>Download GPX</button>
        <a className="ghost" href={appleTripUrl(route, labels)} target="_blank" rel="noreferrer">Whole trip in Apple Maps</a>
      </div>
      <div className="day-links">
        {days.map((d) => (
          <a key={d.url} className="ghost" href={d.url} target="_blank" rel="noreferrer">
            {days.length > 1 ? `${d.label} in Google Maps` : 'Whole trip in Google Maps'}
          </a>
        ))}
      </div>
      <p className="muted small">
        Google, Apple and Waze route like cars between the stops and don’t know your truck’s height, weight or hazmat
        limits; check them against a truck GPS. Google links go a day at a time (it keeps 9 stops per link). Waze takes
        one leg at a time. GPX has the exact route and stops. Stop times are estimates, not your HOS record.
      </p>
    </section>
  )
}
