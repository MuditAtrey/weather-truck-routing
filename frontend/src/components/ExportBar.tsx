import type { Plan } from '../api/client'
import { appleMapsUrl, downloadGpx, googleMapsUrl, stopsOf, wazeUrl } from '../lib/export'
import { clock } from '../lib/format'

interface Props {
  plan: Plan
  selected: number
  labels: [string, string]
}

export default function ExportBar({ plan, selected, labels }: Props) {
  const route = plan.routes.features[selected]
  if (!route) return null
  const stops = stopsOf(route)
  return (
    <section className="export" aria-label={`Take Route ${route.properties.name} with you`}>
      <h3>Take Route {route.properties.name} with you</h3>
      <div className="export-actions">
        <button type="button" className="ghost" onClick={() => downloadGpx(plan, route, labels)}>
          Download GPX
        </button>
        <a className="ghost" href={googleMapsUrl(route)} target="_blank" rel="noreferrer">
          Google Maps
        </a>
        <a className="ghost" href={wazeUrl(route)} target="_blank" rel="noreferrer">
          Waze
        </a>
        <a className="ghost" href={appleMapsUrl(route)} target="_blank" rel="noreferrer">
          Apple Maps
        </a>
      </div>
      <p className="muted small">
        GPX has the exact route and rest stops, for apps that import routes. Google Maps gets the rest stops and
        points along the route (re-routed by Google, for cars). Waze and Apple Maps links only take the destination.
      </p>
      {stops.length > 0 && (
        <ol className="stops">
          {stops.map((s, i) => (
            <li key={i}>
              <span className={`stop-dot ${s.kind}`} aria-hidden />
              {s.kind === 'rest' ? '10-hour rest' : '30-minute break'} at mile {Math.round(s.mile).toLocaleString('en-US')}
              <span className="muted"> · {clock(s.at, plan.timezone)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
