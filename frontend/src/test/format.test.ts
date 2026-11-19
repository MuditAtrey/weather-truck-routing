import { describe, expect, it } from 'vitest'
import { duration, localInputValue } from '../lib/format'
import { levelAt } from '../lib/risk'

describe('formatting', () => {
  it('durations read naturally from minutes to days', () => {
    expect(duration(45 * 60)).toBe('45 min')
    expect(duration(2 * 3600 + 5 * 60)).toBe('2 h 05 m')
    expect(duration(88 * 3600)).toBe('3 d 16 h')
  })

  it('datetime-local values round down to 15 minutes', () => {
    expect(localInputValue('America/Denver')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:(00|15|30|45)$/)
  })

  it('risk level strings decode, with u as unknown', () => {
    expect([levelAt('04u', 0), levelAt('04u', 1), levelAt('04u', 2)]).toEqual([0, 4, null])
  })
})
