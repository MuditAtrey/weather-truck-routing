// Splits each route into the stretches its checkpoints stand for (halfway to each
// neighbour), so the line itself can be coloured by risk instead of a chain of dots.
// Segment ids equal checkpoint ids, so both share the same feature-state levels.
import type { Feature, FeatureCollection, LineString, Position } from 'geojson'
import type { Plan } from '../api/client'

const R_MI = 3958.7613
const rad = Math.PI / 180

function hav(a: Position, b: Position): number {
  const dLat = (b[1]! - a[1]!) * rad
  const dLon = (b[0]! - a[0]!) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1]! * rad) * Math.cos(b[1]! * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)))
}

export type SegmentProps = { route: number }

export function routeSegments(plan: Plan): FeatureCollection<LineString, SegmentProps> {
  const features: Feature<LineString, SegmentProps>[] = []
  plan.routes.features.forEach((route, rid) => {
    const coords = route.geometry.coordinates
    const cum = [0]
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1]! + hav(coords[i - 1]!, coords[i]!))
    // Scale our haversine miles to the route's reported length so cuts line up.
    const scale = cum[cum.length - 1]! > 0 ? route.properties.distance_mi / cum[cum.length - 1]! : 1
    const at = (mile: number): [number, Position] => {
      const m = mile / scale
      // First vertex at or beyond m (binary search; routes have thousands of vertices).
      let lo = 1, hi = cum.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (cum[mid]! < m) lo = mid + 1
        else hi = mid
      }
      const i = lo
      const span = cum[i]! - cum[i - 1]! || 1
      const t = Math.max(0, Math.min(1, (m - cum[i - 1]!) / span))
      const a = coords[i - 1]!
      const b = coords[i]!
      return [i, [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t]]
    }
    const cps = plan.checkpoints.features
      .map((f, gi) => ({ gi, p: f.properties }))
      .filter((c) => c.p.route === rid)
    cps.forEach((c, k) => {
      const from = k === 0 ? 0 : (cps[k - 1]!.p.mile + c.p.mile) / 2
      const to = k === cps.length - 1 ? route.properties.distance_mi : (c.p.mile + cps[k + 1]!.p.mile) / 2
      if (to - from <= 0) return
      const [i0, p0] = at(from)
      const [i1, p1] = at(to)
      const line = [p0, ...coords.slice(i0, i1), p1]
      features.push({ type: 'Feature', id: c.gi + 1, geometry: { type: 'LineString', coordinates: line }, properties: { route: rid } })
    })
  })
  return { type: 'FeatureCollection', features }
}
