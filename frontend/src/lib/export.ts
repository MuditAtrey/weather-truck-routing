// Sending a planned route to a navigation app.
//
// What each target can actually take (checked against their docs, Nov 2026):
// - GPX file: the exact route line plus the rest stops; many navigation and truck apps
//   can import it.
// - Google Maps link: origin, destination and up to 9 stops (3 in mobile browsers).
//   Google re-routes between the stops with its own (car) routing.
// - Waze and Apple Maps links: a destination only.
import type { Plan, RouteFeature } from '../api/client'

export interface RouteStop {
  kind: 'break' | 'rest'
  lat: number
  lon: number
  mile: number
  at: number
  duration_s: number
}

const STOP_NAME = { break: '30-minute break', rest: '10-hour rest' } as const
const ll = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`

function stopsOf(route: RouteFeature): RouteStop[] {
  return route.properties.stops ?? []
}

/** Up to `n` points along the line, evenly spaced by vertex count, ends excluded. */
function shapePoints(route: RouteFeature, n: number): [number, number][] {
  const c = route.geometry.coordinates
  return Array.from({ length: n }, (_, k) => {
    const p = c[Math.round(((k + 1) * (c.length - 1)) / (n + 1))]!
    return [p[1]!, p[0]!] as [number, number]
  })
}

export function googleMapsUrl(route: RouteFeature, maxStops = 9): string {
  const c = route.geometry.coordinates
  const [olon, olat] = c[0] as [number, number]
  const [dlon, dlat] = c[c.length - 1] as [number, number]
  // Rest stops first (they matter to the driver), then shape points to hold the corridor.
  const rest = stopsOf(route).slice(0, maxStops).map((s) => ({ mile: s.mile, p: [s.lat, s.lon] as [number, number] }))
  const spare = maxStops - rest.length
  const total = route.properties.distance_mi
  const shape = shapePoints(route, spare).map((p, k) => ({ mile: ((k + 1) * total) / (spare + 1), p }))
  const waypoints = [...rest, ...shape].sort((a, b) => a.mile - b.mile).map((w) => ll(w.p[0], w.p[1]))
  const params = new URLSearchParams({
    api: '1',
    origin: ll(olat, olon),
    destination: ll(dlat, dlon),
    travelmode: 'driving',
  })
  if (waypoints.length) params.set('waypoints', waypoints.join('|'))
  return `https://www.google.com/maps/dir/?${params}`
}

export function wazeUrl(route: RouteFeature): string {
  const c = route.geometry.coordinates
  const [lon, lat] = c[c.length - 1] as [number, number]
  return `https://www.waze.com/ul?ll=${ll(lat, lon)}&navigate=yes`
}

export function appleMapsUrl(route: RouteFeature): string {
  const c = route.geometry.coordinates
  const [olon, olat] = c[0] as [number, number]
  const [dlon, dlat] = c[c.length - 1] as [number, number]
  return `https://maps.apple.com/?saddr=${ll(olat, olon)}&daddr=${ll(dlat, dlon)}&dirflg=d`
}

const esc = (s: string) => s.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

/** GPX 1.1: start, rest stops and destination as waypoints; the full line as a track. */
export function gpx(plan: Plan, route: RouteFeature, labels: [string, string]): string {
  const c = route.geometry.coordinates
  const name = `Route ${route.properties.name}: ${labels[0]} to ${labels[1]}`
  const iso = (t: number) => new Date(t * 1000).toISOString()
  const wpt = (lat: number, lon: number, title: string, desc: string, time?: number) =>
    `  <wpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${time ? `<time>${iso(time)}</time>` : ''}` +
    `<name>${esc(title)}</name><desc>${esc(desc)}</desc></wpt>`
  const [olon, olat] = c[0] as [number, number]
  const [dlon, dlat] = c[c.length - 1] as [number, number]
  const points = [
    wpt(olat, olon, labels[0], 'Start', plan.departure),
    ...stopsOf(route).map((s) =>
      wpt(s.lat, s.lon, STOP_NAME[s.kind], `Mile ${Math.round(s.mile)}; ${Math.round(s.duration_s / 60)} min stop`, s.at),
    ),
    wpt(dlat, dlon, labels[1], 'Destination', plan.departure + route.properties.trip_s),
  ]
  // Keep the file small: every 3rd vertex is still far finer than any app needs.
  const step = c.length > 9000 ? 3 : 1
  const track = c
    .filter((_, i) => i % step === 0 || i === c.length - 1)
    .map(([lon, lat]) => `<trkpt lat="${lat!.toFixed(6)}" lon="${lon!.toFixed(6)}"/>`)
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="Weather-aware truck routing" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    `  <metadata><name>${esc(name)}</name></metadata>\n` +
    points.join('\n') +
    `\n  <trk><name>${esc(name)}</name><trkseg>${track}</trkseg></trk>\n</gpx>\n`
  )
}

export function downloadGpx(plan: Plan, route: RouteFeature, labels: [string, string]) {
  const blob = new Blob([gpx(plan, route, labels)], { type: 'application/gpx+xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const slug = `${labels[0]}-${labels[1]}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  a.href = url
  a.download = `route-${route.properties.name.toLowerCase()}-${slug}.gpx`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export { stopsOf, STOP_NAME }
