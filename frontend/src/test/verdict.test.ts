import { describe, expect, it } from 'vitest'
import { verdictFor } from '../lib/verdict'
import { makePlan, makeScore } from './fixtures'

const plan = makePlan()

describe('verdict line', () => {
  it('names the worst hazard, its peak and an action', () => {
    const v = verdictFor(plan, makeScore('012210', [10, 30, 40, 44, 38, 12]), 'gust', 0)
    expect(v.level).toBe(2)
    expect(v.hazard).toBe('Gusts to 44 mph')
    expect(v.action).toMatch(/delaying/)
    expect(v.point).not.toBeNull()
  })

  it('says Low risk when nothing is above Low', () => {
    expect(verdictFor(plan, makeScore('000000', [5, 5, 5, 5, 5, 5]), 'gust', 0).hazard).toBe('Low risk throughout')
  })

  it('reports missing forecasts instead of calling them calm', () => {
    expect(verdictFor(plan, makeScore('uuuuuu', [0, 0, 0, 0, 0, 0]), 'gust', 0).level).toBeNull()
  })
})
