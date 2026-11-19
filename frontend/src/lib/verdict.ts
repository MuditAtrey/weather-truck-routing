// One line per route that a dispatcher can act on: the worst hazard, where, when, and
// what to do, in the "impact + action" style state DOTs use (e.g. Wyoming's travel
// impact levels), without borrowing official NWS warning names.
import type { ModeResult, Plan, ScoreOut } from '../api/client'
import { clock } from './format'
import { STATE_ABBR } from './geocode'
import { levelAt, type WindMode } from './risk'

export interface Verdict {
  level: number | null // worst level on the route, null if no forecast at all
  hazard: string // "Gusts to 52 mph"
  when: string // "Tue 2-5 AM MST"
  action: string
  point: [number, number] | null // lat, lon of the worst stretch (for "near <town>")
}

const ACTION = [
  'No significant wind, rain or snow forecast along this route.',
  'Use caution.',
  'Consider delaying or an alternative route.',
  'Delay travel or take a safer route.',
  'Do not dispatch on this route at this time.',
]

export function verdictFor(plan: Plan, score: ScoreOut, mode: WindMode, routeId: number): Verdict {
  const result: ModeResult = score[mode]
  const idx = plan.checkpoints.features
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.properties.route === routeId)
  let worst = -1
  for (const { i } of idx) worst = Math.max(worst, levelAt(result.checkpoint_levels, i) ?? -1)
  if (worst < 0) return { level: null, hazard: 'No forecast available', when: '', action: '', point: null }
  if (worst === 0) return { level: 0, hazard: 'Low risk throughout', when: '', action: ACTION[0]!, point: null }

  // The worst stretch: checkpoints at the worst level, earliest run of them.
  const hits = idx.filter(({ i }) => levelAt(result.checkpoint_levels, i) === worst)
  const first = hits[0]!
  const last = hits.filter(({ f }) => f.properties.eta - first.f.properties.eta <= 12 * 3600).at(-1)!
  // What drove it, and the peak value along that stretch.
  const driver = result.checkpoint_drivers[first.i] ?? 'w'
  let peak = 0
  for (const { i } of hits) {
    const c = score.conditions[i]
    if (!c) continue
    if (driver === 'w') peak = Math.max(peak, (mode === 'gust' ? c.gust : c.wind) ?? 0)
    else if (driver === 'r') peak = Math.max(peak, c.rain ?? 0)
    else peak = Math.max(peak, c.snow ?? 0)
  }
  const hazard =
    driver === 'w'
      ? `${mode === 'gust' ? 'Gusts' : 'Wind'} to ${Math.round(peak)} mph`
      : driver === 'r'
        ? `Rain to ${peak.toFixed(2)} in/hr`
        : `Snow to ${peak.toFixed(1)} in/hr`
  const t0 = first.f.properties.eta
  const t1 = last.f.properties.eta
  const when = t1 - t0 < 1800 ? clock(t0, plan.timezone) : `${clock(t0, plan.timezone)} to ${clock(t1, plan.timezone, false)}`
  const [lon, lat] = first.f.geometry.coordinates as [number, number]
  return { level: worst, hazard, when, action: ACTION[worst]!, point: [lat, lon] }
}

const placeCache = new Map<string, Promise<string>>()

/** "near Rawlins, WY" from Photon's reverse geocoder (cached; empty string on failure). */
export function nearestPlace(point: [number, number]): Promise<string> {
  const key = `${point[0].toFixed(2)},${point[1].toFixed(2)}`
  let p = placeCache.get(key)
  if (!p) {
    // No layer filter: on a highway the nearest object is a road, which carries its town.
    const params = new URLSearchParams({ lat: point[0].toFixed(4), lon: point[1].toFixed(4), lang: 'en' })
    p = fetch(`https://photon.komoot.io/reverse?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const props = d?.features?.[0]?.properties
        if (!props) return ''
        const town = props.city ?? props.county ?? (props.type === 'city' ? props.name : undefined)
        const state = props.state ? (STATE_ABBR[props.state] ?? props.state) : ''
        return town ? `near ${town}${state ? `, ${state}` : ''}` : ''
      })
      .catch(() => '')
    placeCache.set(key, p)
  }
  return p
}
