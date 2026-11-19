import { describe, expect, it } from 'vitest'
import { hazards } from '../lib/hazards'
import { hazardSymbol, stopSymbol, symbolSvg } from '../lib/symbols'
import { makePlan, makeScore } from './fixtures'

describe('hazards', () => {
  it('puts one marker per High+ stretch, at its worst point', () => {
    const plan = makePlan()
    // Levels per checkpoint: Low, High, Severe, Low, High, Low.
    const fc = hazards(plan, makeScore('023020', [10, 40, 50, 10, 38, 10]), 'gust')
    expect(fc.features.map((f) => [f.properties.cp, f.properties.sym])).toEqual([
      [2, 'severe'],
      [4, 'high'],
    ])
  })

  it('shows nothing when no stretch reaches High', () => {
    expect(hazards(makePlan(), makeScore('011100', [10, 30, 30, 30, 10, 10]), 'gust').features).toHaveLength(0)
  })

  it('treats unknown forecasts as no marker (they are drawn grey instead)', () => {
    expect(hazards(makePlan(), makeScore('0uu000', [10, 0, 0, 10, 10, 10]), 'gust').features).toHaveLength(0)
  })
})

describe('symbols', () => {
  it('maps stops and levels to one shared symbol set', () => {
    expect(stopSymbol('rest', true)).toBe('rest')
    expect(stopSymbol('break', false)).toBe('break-unknown')
    expect([0, 1, 2, 3, 4].map(hazardSymbol)).toEqual([null, null, 'high', 'severe', 'notravel'])
  })

  it('renders the same parts as SVG for popups', () => {
    const svg = symbolSvg('notravel', 18)
    expect(svg).toMatch(/^<svg[^>]+width="18"/)
    expect(svg).toContain('#5c0517')
  })
})
