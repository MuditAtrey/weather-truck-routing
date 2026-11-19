// Where the truck is at any moment, on the road itself (not on straight lines between
// checkpoints), and what it meets there.
//
// Time to distance: checkpoints carry both clock time (eta) and driving time (drive_s),
// so required stops are taken out first: during a break or rest the truck stands still
// at the stop, and between stops it advances by driving time. Distance to position walks
// the route geometry, so the marker sits on the drawn line on curves too.
import type { Position } from 'geojson'
import type { Plan, RouteProps } from '../api/client'

const R_MI = 3958.7613
const rad = Math.PI / 180

export function hav(a: Position, b: Position): number {
  const dLat = (b[1]! - a[1]!) * rad
  const dLon = (b[0]! - a[0]!) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1]! * rad) * Math.cos(b[1]! * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function bearingDeg(a: Position, b: Position): number {
  const [lon1, lat1] = [a[0]! * rad, a[1]! * rad]
  const [lon2, lat2] = [b[0]! * rad, b[1]! * rad]
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1)
  return (Math.atan2(y, x) / rad + 360) % 360
}

export interface TruckState {
  pos: [number, number]
  bearing: number
  mile: number
  /** Index into plan.checkpoints of the checkpoint whose stretch the truck is on. */
  cp: number
  stop: RouteProps['stops'][number] | null
  status: 'before' | 'driving' | 'stopped' | 'arrived'
}

export interface Track {
  route: number
  at: (t: number) => TruckState
  /** Position and heading at a route mile. */
  pointAt: (mile: number) => { pos: [number, number]; bearing: number }
}

export function createTrack(plan: Plan, route: number): Track | null {
  const feature = plan.routes.features[route]
  if (!feature) return null
  const props = feature.properties
  const coords = feature.geometry.coordinates
  const cum = [0]
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1]! + hav(coords[i - 1]!, coords[i]!))
  const total = cum[cum.length - 1]!
  const scale = total > 0 ? props.distance_mi / total : 1

  const cps = plan.checkpoints.features
    .map((f, gi) => ({ gi, mile: f.properties.mile, drive: f.properties.drive_s }))
    .filter((_, gi) => plan.checkpoints.features[gi]!.properties.route === route)

  const pointAt = (mile: number) => {
    const m = Math.max(0, Math.min(total, mile / scale))
    let lo = 1, hi = cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid]! < m) lo = mid + 1
      else hi = mid
    }
    const i = Math.max(1, lo)
    const a = coords[i - 1]!, b = coords[i]!
    const span = cum[i]! - cum[i - 1]! || 1
    const f = Math.max(0, Math.min(1, (m - cum[i - 1]!) / span))
    // Heading from a short look-around, so tiny zigzags in the geometry don't spin it.
    const back = Math.max(0, i - 3), ahead = Math.min(coords.length - 1, i + 2)
    return {
      pos: [a[0]! + (b[0]! - a[0]!) * f, a[1]! + (b[1]! - a[1]!) * f] as [number, number],
      bearing: bearingDeg(coords[back]!, coords[ahead]!),
    }
  }

  /** Route mile after `d` seconds of driving (piecewise linear through checkpoints). */
  const mileAtDrive = (d: number) => {
    const pts = [{ mile: 0, drive: 0 }, ...cps, { mile: props.distance_mi, drive: props.drive_s }]
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1]!, b = pts[k]!
      if (d <= b.drive) {
        const span = b.drive - a.drive
        return span > 0 ? a.mile + ((b.mile - a.mile) * (d - a.drive)) / span : b.mile
      }
    }
    return props.distance_mi
  }

  const cpAt = (mile: number) => {
    let best = cps[0]?.gi ?? -1
    let bestD = Infinity
    for (const c of cps) {
      const d = Math.abs(c.mile - mile)
      if (d < bestD) { bestD = d; best = c.gi }
    }
    return best
  }

  const at = (t: number): TruckState => {
    const elapsed = t - plan.departure
    if (elapsed <= 0) {
      const p = pointAt(0)
      return { ...p, mile: 0, cp: cpAt(0), stop: null, status: 'before' }
    }
    if (elapsed >= props.trip_s) {
      const p = pointAt(props.distance_mi)
      return { ...p, mile: props.distance_mi, cp: cpAt(props.distance_mi), stop: null, status: 'arrived' }
    }
    let drive = elapsed
    for (const s of props.stops) {
      const start = s.at - plan.departure
      if (elapsed < start) break
      if (elapsed < start + s.duration_s) {
        const mile = s.mile
        const p = pointAt(mile)
        // Parked at the stop's marker (a truck stop can sit a little off the route).
        const pos: [number, number] = s.place ? [s.place.lon, s.place.lat] : p.pos
        return { pos, bearing: p.bearing, mile, cp: cpAt(mile), stop: s, status: 'stopped' }
      }
      drive -= s.duration_s
    }
    const mile = mileAtDrive(drive)
    return { ...pointAt(mile), mile, cp: cpAt(mile), stop: null, status: 'driving' }
  }

  return { route, at, pointAt }
}
