import { describe, expect, it } from 'vitest'
import { appleTripUrl, googleDayLinks, gpx, itineraryText, legs } from '../lib/export'
import { stopSymbol } from '../lib/symbols'
import { createTrack } from '../lib/track'
import { makePlan } from './fixtures'

// The fixture route with a stop the user added at mile 800 (between the first rest and
// the second break), the way the API returns it: kind 'via', no duration.
function planWithStop() {
  const plan = makePlan()
  const route = plan.routes.features[0]!
  const c = route.geometry.coordinates[Math.round((800 / 1500) * 400)]!
  route.properties.stops.push({
    kind: 'via', lat: c[1]!, lon: c[0]!, mile: 800, at: 1_800_000_000 + 60_000, duration_s: 0, early_min: 0,
    place: { name: 'Columbus, OH', kind: 'stop', road: null, spaces: null, off_route_mi: 0, lat: c[1]!, lon: c[0]!, source: 'user' },
  })
  route.properties.stops.sort((a, b) => a.mile - b.mile)
  return { plan, route, point: `${c[1]!.toFixed(5)},${c[0]!.toFixed(5)}` }
}

describe('stops the user adds', () => {
  it('every Google day link that spans the stop keeps it', () => {
    const { route, point } = planWithStop()
    const days = googleDayLinks(route, ['Start', 'End'])
    const withStop = days.filter((d) => new URL(d.url).searchParams.get('waypoints')?.includes(point))
    expect(withStop).toHaveLength(1)
    for (const d of days) expect(new URL(d.url).searchParams.get('waypoints')!.split('|').length).toBeLessThanOrEqual(9)
  })

  it('Apple, Waze legs, GPX and the text itinerary include it', () => {
    const { plan, route, point } = planWithStop()
    expect(appleTripUrl(route, ['Start', 'End'])).toContain(`waypoint=${point}`)
    expect(legs(route, ['Start', 'End']).map((l) => l.toLabel)).toContain('Columbus, OH')
    const xml = gpx(plan, route, ['Start', 'End'])
    expect(xml).toContain('<name>Columbus, OH</name>')
    expect(itineraryText(plan, route, ['Start', 'End'], String)).toContain('stop at Columbus, OH')
  })

  it('has its own symbol and does not stop the truck', () => {
    const { plan, route } = planWithStop()
    expect(stopSymbol('via', true)).toBe('via')
    const stop = route.properties.stops.find((s) => s.kind === 'via')!
    // A pass-through stop takes no time: the truck is never shown waiting there.
    const track = createTrack(plan, 0)!
    for (const dt of [-60, 0, 1, 60]) expect(track.at(stop.at + dt).stop?.kind).not.toBe('via')
  })
})
