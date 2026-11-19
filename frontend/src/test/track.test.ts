import { describe, expect, it } from 'vitest'
import { createTrack } from '../lib/track'
import { makePlan } from './fixtures'

// The fixture drives 1,500 mi in 90,000 s (60 s per mile); give its stops matching times.
function plan() {
  const p = makePlan()
  const route = p.routes.features[0]!.properties
  let paused = 0
  for (const s of route.stops) {
    s.at = p.departure + s.mile * 60 + paused
    paused += s.duration_s
  }
  route.trip_s = route.drive_s + paused
  return p
}

describe('createTrack', () => {
  it('parks at the origin before departure and at the destination after arrival', () => {
    const p = plan()
    const t = createTrack(p, 0)!
    const coords = p.routes.features[0]!.geometry.coordinates
    expect(t.at(p.departure - 600)).toMatchObject({ status: 'before', pos: coords[0] })
    const end = t.at(p.departure + p.routes.features[0]!.properties.trip_s + 1)
    expect(end.status).toBe('arrived')
    expect(end.pos[0]).toBeCloseTo(coords.at(-1)![0]!, 5)
  })

  it('stands still at the stop during a break or rest', () => {
    const p = plan()
    const t = createTrack(p, 0)!
    const rest = p.routes.features[0]!.properties.stops[1]!
    const a = t.at(rest.at + 60)
    const b = t.at(rest.at + rest.duration_s - 60)
    expect(a.status).toBe('stopped')
    expect(a.stop?.kind).toBe('rest')
    expect(a.pos).toEqual([rest.place!.lon, rest.place!.lat])
    expect(b.pos).toEqual(a.pos)
  })

  it('advances by driving time, not clock time, after a stop', () => {
    const p = plan()
    const t = createTrack(p, 0)!
    const brk = p.routes.features[0]!.properties.stops[0]!
    // An hour of driving after the 30-minute break ends: 60 more miles.
    const s = t.at(brk.at + brk.duration_s + 3600)
    expect(s.status).toBe('driving')
    expect(s.mile).toBeCloseTo(brk.mile + 60, 0)
  })

  it('moves forward along the drawn line', () => {
    const p = plan()
    const t = createTrack(p, 0)!
    let last = -1
    for (let k = 1; k < 30; k++) {
      const s = t.at(p.departure + k * 1000)
      if (s.status !== 'driving') continue
      expect(s.mile).toBeGreaterThanOrEqual(last)
      last = s.mile
      // The fixture route is a straight line from (-100, 35) to (-80, 43).
      const f = (s.pos[0] + 100) / 20
      expect(s.pos[1]).toBeCloseTo(35 + f * 8, 3)
      // Heading north-east.
      expect(s.bearing).toBeGreaterThan(30)
      expect(s.bearing).toBeLessThan(80)
    }
    expect(last).toBeGreaterThan(300)
  })

  it('reports the nearest checkpoint for the conditions readout', () => {
    const p = plan()
    const t = createTrack(p, 0)!
    // Mile ~600 is checkpoint index 2 (checkpoints every 300 mi).
    expect(t.at(p.departure + 590 * 60 + 1800).cp).toBe(2)
  })
})
