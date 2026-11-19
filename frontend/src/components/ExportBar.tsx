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
import { stopSymbol } from '../lib/symbols'
import Symbol from './Symbol'

interface Props {
  plan: Plan
  selected: number
  labels: [string, string]
}

const KIND = { truck_stop: 'Truck stop', public: 'Rest area', truck_parking: 'Truck parking', stop: 'Your stop' } as const

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
    <>
      <details className="section" open={stops.length <= 4}>
        <summary>
          Stops and itinerary <span className="muted">· {stops.length ? `${stops.length} stop${stops.length > 1 ? 's' : ''}` : 'no stops needed'}</span>
        </summary>
        <ol className="itinerary" aria-label={`Route ${route.properties.name} itinerary`}>
          <li>
            <Symbol id="start" size={20} />
            <div>
              <strong>{labels[0]}</strong>
              <div className="muted">Leave {t(plan.departure)}</div>
            </div>
          </li>
          {stops.map((s, i) =>
            s.kind === 'via' ? (
              <li key={i} className="it-via">
                <Symbol id="via" size={20} />
                <div>
                  <strong>{s.place?.name ?? 'Your stop'}</strong>
                  <div className="muted">Your stop · mile {Math.round(s.mile).toLocaleString('en-US')} · {t(s.at)}</div>
                  <LegLinks i={i} />
                </div>
              </li>
            ) : (
            <li key={i}>
              <Symbol id={stopSymbol(s.kind, !!s.place)} size={20} />
              <div>
                <strong>{STOP_NAME[s.kind]}</strong>
                <span className="muted"> · {t(s.at)}</span>
                {s.place ? (
                  <div>
                    {s.place.name}
                    <span className="muted">
                      {' '}· {KIND[s.place.kind]}
                      {s.place.road ? `, ${s.place.road}` : ''}
                      {s.place.spaces ? ` · ${s.place.spaces} spaces` : ''}
                      {s.place.off_route_mi >= 0.3 ? ` · ${s.place.off_route_mi} mi off route` : ''}
                    </span>
                  </div>
                ) : (
                  <div className="warn-text">No known truck parking before the limit here. Plan parking ahead.</div>
                )}
                <div className="muted">
                  Mile {Math.round(s.mile).toLocaleString('en-US')}
                  {s.early_min >= 45 ? ` · stops ${Math.round(s.early_min / 6) / 10} h early: the next parking is past the limit` : ''}
                </div>
                <LegLinks i={i} />
              </div>
            </li>
            ),
          )}
          <li>
            <Symbol id="end" size={20} />
            <div>
              <strong>{labels[1]}</strong>
              <div className="muted">Arrive {t(plan.departure + route.properties.trip_s)}</div>
              <LegLinks i={legList.length - 1} />
            </div>
          </li>
        </ol>
      </details>
      <details className="section">
        <summary>Send to driver</summary>
        <div className="send">
          <div className="export-actions">
            <button type="button" className="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy itinerary'}</button>
            <button type="button" className="ghost" onClick={() => downloadGpx(plan, route, labels)} title="For truck GPS units and apps that import GPX">
              Download GPX
            </button>
            <a className="ghost" href={appleTripUrl(route, labels)} target="_blank" rel="noreferrer">Whole trip in Apple Maps</a>
            {days.map((d) => (
              <a key={d.url} className="ghost" href={d.url} target="_blank" rel="noreferrer">
                {days.length > 1 ? `${d.label} in Google Maps` : 'Whole trip in Google Maps'}
              </a>
            ))}
          </div>
          <p className="muted small">
            GPX carries the exact route and stops. Google, Apple and Waze route like cars between stops and don’t know
            height, weight or hazmat limits, so check against a truck GPS. Google takes 9 stops per link, so it goes a
            day at a time; Waze takes one leg at a time. Stop times are estimates, not an HOS record.
          </p>
        </div>
      </details>
    </>
  )
}
