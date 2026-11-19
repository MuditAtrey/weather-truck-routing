import { describe, expect, it } from 'vitest'
import { appleTripUrl, googleDayLinks, gpx, itineraryText, legLinks, legs } from '../lib/export'
import { makePlan } from './fixtures'

const plan = makePlan()
const route = plan.routes.features[0]!
const labels: [string, string] = ['Dallas, TX', 'Denver, CO']
const stopKey = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`

describe('Google Maps day links', () => {
  const days = googleDayLinks(route, labels)

  it('splits the trip at each 10-hour rest', () => {
    expect(days).toHaveLength(3) // start -> rest 1 -> rest 2 -> destination
  })

  it('never exceeds 9 stops per link', () => {
    for (const d of days) {
      const wps = new URL(d.url).searchParams.get('waypoints')?.split('|') ?? []
      expect(wps.length).toBeLessThanOrEqual(9)
    }
  })

  it('keeps every planned stop somewhere in the links', () => {
    const all = days.map((d) => decodeURIComponent(d.url)).join(' ')
    for (const s of route.properties.stops) {
      const p = s.place ? stopKey(s.place.lat, s.place.lon) : stopKey(s.lat, s.lon)
      expect(all).toContain(p)
    }
  })

  it('uses the picked place names at the trip ends', () => {
    expect(new URL(days[0]!.url).searchParams.get('origin')).toBe('Dallas, TX')
    expect(new URL(days.at(-1)!.url).searchParams.get('destination')).toBe('Denver, CO')
  })
})

describe('Apple Maps and Waze', () => {
  it('Apple gets every stop in the new multi-stop format', () => {
    const url = appleTripUrl(route, labels)
    expect(url).toMatch(/^https:\/\/maps\.apple\.com\/directions\?/)
    expect((url.match(/waypoint=/g) ?? []).length).toBeGreaterThanOrEqual(route.properties.stops.length)
  })

  it('Waze goes leg by leg, each with a start and an end', () => {
    const l = legs(route, labels)
    expect(l).toHaveLength(route.properties.stops.length + 1)
    const w = legLinks(l[0]!).waze
    expect(w).toMatch(/from=ll\.[-\d.]+,[-\d.]+&to=ll\.[-\d.]+,[-\d.]+/)
  })
})

describe('GPX and itinerary text', () => {
  it('GPX has start, stops and destination, a route and a track', () => {
    const g = gpx(plan, route, labels)
    expect((g.match(/<wpt /g) ?? []).length).toBe(route.properties.stops.length + 2)
    expect(g).toContain('<rte>')
    expect(g).toContain('<trk>')
    expect(g.indexOf('<wpt')).toBeLessThan(g.indexOf('<rte>')) // schema order: wpt, rte, trk
    expect(g.indexOf('<rte>')).toBeLessThan(g.indexOf('<trk>'))
  })

  it('escapes place names in XML', () => {
    expect(gpx(plan, route, ['A & B', 'C <D>'])).toContain('A &#38; B')
  })

  it('itinerary text lists every stop and says where parking is unknown', () => {
    const text = itineraryText(plan, route, labels, (t) => String(t))
    expect(text).toContain("Love's Travel Stop")
    expect(text).toContain('no known truck parking nearby')
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(route.properties.stops.length + 1)
  })
})
