// Handing a planned route to the apps drivers use. What each target really does was
// checked in a browser (Nov 2026), not taken from docs alone:
// - Google Maps link: keeps up to 9 stops in order, then routes between them itself
//   (car routing). So: one link per driving day, holding the corridor with route points.
// - Apple Maps `maps.apple.com/directions?...&waypoint=` link: kept 12+ stops in order
//   (the old saddr/daddr form ignored stops). So: one link for the whole trip.
// - Waze: start and destination only, and its web map refuses very long trips. So: one
//   link per leg, stop to stop.
// - GPX: exact line plus stops, for apps that import routes.
import type { Plan, RouteFeature, RouteProps } from '../api/client'

export type RouteStop = RouteProps['stops'][number]

export interface Leg {
  from: [number, number] // lat, lon
  to: [number, number]
  toLabel: string
}

const STOP_NAME = { break: '30-minute break', rest: '10-hour rest', via: 'Stop' } as const
const ll = ([lat, lon]: [number, number]) => `${lat.toFixed(5)},${lon.toFixed(5)}`
const R_MI = 3958.7613

export function stopsOf(route: RouteFeature): RouteStop[] {
  return route.properties.stops ?? []
}

/** Where a stop is: the truck stop itself when we know it, else the point on the route. */
export function stopPoint(s: RouteStop): [number, number] {
  return s.place ? [s.place.lat, s.place.lon] : [s.lat, s.lon]
}

export function stopTitle(s: RouteStop): string {
  if (s.kind === 'via') return s.place?.name ?? 'Stop'
  if (!s.place) return `${STOP_NAME[s.kind]} (no known truck parking)`
  return `${STOP_NAME[s.kind]} at ${s.place.name}`
}

function endpoints(route: RouteFeature): { start: [number, number]; end: [number, number] } {
  const c = route.geometry.coordinates
  const [olon, olat] = c[0] as [number, number]
  const [dlon, dlat] = c[c.length - 1] as [number, number]
  return { start: [olat, olon], end: [dlat, dlon] }
}

/** Points on the route line between two mileposts, evenly spaced (to hold the corridor). */
function corridor(route: RouteFeature, fromMi: number, toMi: number, n: number): { mile: number; p: [number, number] }[] {
  if (n <= 0 || toMi - fromMi < 30) return []
  const c = route.geometry.coordinates
  const scale = route.properties.distance_mi
  const cum = [0]
  for (let i = 1; i < c.length; i++) {
    const [lon1, lat1] = c[i - 1] as [number, number]
    const [lon2, lat2] = c[i] as [number, number]
    const r = Math.PI / 180
    const h =
      Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
    cum.push(cum[i - 1]! + 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h))))
  }
  const k = scale / (cum[cum.length - 1] || 1)
  const out: { mile: number; p: [number, number] }[] = []
  let j = 0
  for (let q = 1; q <= n; q++) {
    const mile = fromMi + ((toMi - fromMi) * q) / (n + 1)
    while (j < cum.length - 1 && cum[j]! * k < mile) j++
    const [lon, lat] = c[j] as [number, number]
    out.push({ mile, p: [lat, lon] })
  }
  return out
}

type End = [number, number] | string // a point, or the place name the user picked

const endText = (e: End) => (typeof e === 'string' ? e : ll(e))

function googleUrl(origin: End, destination: End, waypoints: [number, number][]): string {
  const params = new URLSearchParams({ api: '1', origin: endText(origin), destination: endText(destination), travelmode: 'driving' })
  if (waypoints.length) params.set('waypoints', waypoints.map(ll).join('|'))
  return `https://www.google.com/maps/dir/?${params}`
}

export interface DayLink {
  label: string
  url: string
}

/** One Google Maps link per driving day (start or rest to the next rest or destination). */
export function googleDayLinks(route: RouteFeature, labels?: [string, string]): DayLink[] {
  const { start, end } = endpoints(route)
  const stops = stopsOf(route)
  const rests = stops.filter((s) => s.kind === 'rest')
  const bounds = [
    { mile: 0, p: start, label: 'start' },
    ...rests.map((s) => ({ mile: s.mile, p: stopPoint(s), label: s.place?.name ?? `mile ${Math.round(s.mile)}` })),
    { mile: route.properties.distance_mi, p: end, label: 'destination' },
  ]
  const days: DayLink[] = []
  for (let d = 0; d + 1 < bounds.length; d++) {
    const a = bounds[d]!
    const b = bounds[d + 1]!
    // Breaks and the user's own stops must be kept; route points fill the rest.
    const breaks = stops
      .filter((s) => (s.kind === 'break' || s.kind === 'via') && s.mile > a.mile && s.mile < b.mile)
      .map((s) => ({ mile: s.mile, p: stopPoint(s) }))
    const fill = corridor(route, a.mile, b.mile, 9 - breaks.length)
    const via = [...breaks, ...fill].sort((x, y) => x.mile - y.mile).map((w) => w.p)
    days.push({
      label: bounds.length > 2 ? `Day ${d + 1}: ${a.label === 'start' ? 'start' : a.label} to ${b.label}` : 'Whole trip',
      url: googleUrl(
        d === 0 && labels ? labels[0] : a.p,
        d + 2 === bounds.length && labels ? labels[1] : b.p,
        via,
      ),
    })
  }
  return days
}

/** One Apple Maps link for the whole trip: every stop, plus route points to hold the corridor. */
export function appleTripUrl(route: RouteFeature, labels?: [string, string], maxStops = 15): string {
  const { start, end } = endpoints(route)
  const stops = stopsOf(route).map((s) => ({ mile: s.mile, p: stopPoint(s) }))
  const fill = corridor(route, 0, route.properties.distance_mi, Math.max(0, Math.min(6, maxStops - stops.length)))
  const via = [...stops, ...fill].sort((a, b) => a.mile - b.mile).slice(0, maxStops)
  const enc = (e: End) => encodeURIComponent(endText(e))
  const q = [
    `source=${enc(labels ? labels[0] : start)}`,
    `destination=${enc(labels ? labels[1] : end)}`,
    ...via.map((w) => `waypoint=${ll(w.p)}`),
    'mode=driving',
  ]
  return `https://maps.apple.com/directions?${q.join('&')}`
}

export function legs(route: RouteFeature, labels: [string, string]): Leg[] {
  const { start, end } = endpoints(route)
  const pts: { p: [number, number]; label: string }[] = [
    { p: start, label: labels[0] },
    ...stopsOf(route).map((s) => ({ p: stopPoint(s), label: stopTitle(s) })),
    { p: end, label: labels[1] },
  ]
  return pts.slice(1).map((x, i) => ({ from: pts[i]!.p, to: x.p, toLabel: x.label }))
}

export const legLinks = (leg: Leg) => ({
  google: googleUrl(leg.from, leg.to, []),
  apple: `https://maps.apple.com/directions?source=${ll(leg.from)}&destination=${ll(leg.to)}&mode=driving`,
  waze: `https://www.waze.com/live-map/directions?from=ll.${ll(leg.from)}&to=ll.${ll(leg.to)}&navigate=yes`,
})

/** Plain-text itinerary a dispatcher can paste into a message. */
export function itineraryText(
  plan: Plan,
  route: RouteFeature,
  labels: [string, string],
  clock: (t: number) => string,
): string {
  const p = route.properties
  const lines = [
    `Route ${p.name}: ${labels[0]} to ${labels[1]}`,
    `${Math.round(p.distance_mi).toLocaleString('en-US')} mi, leave ${clock(plan.departure)}, arrive ${clock(plan.departure + p.trip_s)}`,
    '',
  ]
  for (const s of stopsOf(route)) {
    if (s.kind === 'via') {
      lines.push(`- Mile ${Math.round(s.mile)}, ${clock(s.at)}: stop at ${s.place?.name ?? 'your stop'}`)
      continue
    }
    const where = s.place
      ? `${s.place.name}${s.place.road ? ` (${s.place.road})` : ''}${s.place.spaces ? `, ${s.place.spaces} truck spaces` : ''}`
      : 'no known truck parking nearby, plan ahead'
    lines.push(`- Mile ${Math.round(s.mile)}, ${clock(s.at)}: ${STOP_NAME[s.kind]}, ${where}`)
  }
  lines.push(`- Arrive ${labels[1]}: ${clock(plan.departure + p.trip_s)}`)
  return lines.join('\n')
}

const esc = (s: string) => s.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

/**
 * GPX 1.1 with three views of the same trip: waypoints (start, stops, destination),
 * a route (<rte>, what navigation devices import as a trip) and the exact track.
 */
export function gpx(plan: Plan, route: RouteFeature, labels: [string, string]): string {
  const c = route.geometry.coordinates
  const name = `Route ${route.properties.name}: ${labels[0]} to ${labels[1]}`
  const iso = (t: number) => new Date(t * 1000).toISOString()
  const pt = (tag: string, [lat, lon]: [number, number], title: string, desc: string, time?: number) =>
    `<${tag} lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${time ? `<time>${iso(time)}</time>` : ''}` +
    `<name>${esc(title)}</name><desc>${esc(desc)}</desc></${tag}>`
  const { start, end } = endpoints(route)
  const arrive = plan.departure + route.properties.trip_s
  const stops = stopsOf(route)
  const stopDesc = (s: RouteStop) =>
    s.kind === 'via' ? `Stop; mile ${Math.round(s.mile)}` :
    `Mile ${Math.round(s.mile)}; ${Math.round(s.duration_s / 60)} min` +
    (s.place?.spaces ? `; ${s.place.spaces} truck spaces` : '')
  const wpts = [
    pt('wpt', start, labels[0], 'Start', plan.departure),
    ...stops.map((s) => pt('wpt', stopPoint(s), stopTitle(s), stopDesc(s), s.at)),
    pt('wpt', end, labels[1], 'Destination', arrive),
  ]
  // The route: start, stops and corridor points so a device follows the same roads.
  const corridorPts = corridor(route, 0, route.properties.distance_mi, 20).map((w) => ({ ...w, title: '', desc: '' }))
  const rtePts = [
    { mile: 0, p: start, title: labels[0], desc: 'Start' },
    ...stops.map((s) => ({ mile: s.mile, p: stopPoint(s), title: stopTitle(s), desc: stopDesc(s) })),
    ...corridorPts.map((w, i) => ({ ...w, title: `Via ${i + 1}`, desc: 'Route point' })),
    { mile: route.properties.distance_mi, p: end, title: labels[1], desc: 'Destination' },
  ].sort((a, b) => a.mile - b.mile)
  const step = c.length > 9000 ? 3 : 1
  const track = c
    .filter((_, i) => i % step === 0 || i === c.length - 1)
    .map(([lon, lat]) => `<trkpt lat="${lat!.toFixed(6)}" lon="${lon!.toFixed(6)}"/>`)
    .join('')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Weather-aware truck routing" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${esc(name)}</name><time>${iso(plan.departure)}</time></metadata>`,
    ...wpts,
    `<rte><name>${esc(name)}</name>${rtePts.map((r) => pt('rtept', r.p, r.title, r.desc)).join('')}</rte>`,
    `<trk><name>${esc(name)}</name><trkseg>${track}</trkseg></trk>`,
    '</gpx>',
    '',
  ].join('\n')
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

export { STOP_NAME }
