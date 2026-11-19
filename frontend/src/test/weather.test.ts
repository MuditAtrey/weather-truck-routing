import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserWeatherUnavailable, fetchForecasts, missing } from '../lib/weather'

const HOUR = 3600
const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR
const pts = (n: number, lat0 = 30) =>
  Array.from({ length: n }, (_, i) => ({ lat: lat0 + i * 0.01, lon: -100, start: now, end: now + 2 * HOUR }))

function okResponse(n: number) {
  const hourly = {
    time: [0, 1, 2, 3, 4].map((k) => now + k * HOUR),
    wind_speed_10m: [1, 2, 3, 4, 5],
    wind_gusts_10m: [2, 3, 4, 5, 6],
    rain: [0, 0, 0, 0, 0],
    showers: [0, 0, 0, 0, 0],
    snowfall: [0, 0, 0, 0, 0],
  }
  return new Response(JSON.stringify(Array.from({ length: n }, () => ({ hourly }))), { status: 200 })
}

afterEach(() => vi.unstubAllGlobals())

describe('browser forecast download', () => {
  it('fetches up to 1,000 points in one request and slices the right hours', async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => okResponse(String(init.body).split('latitude=')[1]!.split('&')[0]!.split('%2C').length))
    vi.stubGlobal('fetch', fetchMock)
    let got: unknown[] = []
    await fetchForecasts(pts(900), 900, async (w) => void (got = w), () => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(got).toHaveLength(900)
    expect((got[0] as { gust: number[] }).gust).toEqual([2, 3, 4])
  })

  it('reuses forecasts already downloaded in this tab', async () => {
    const fetchMock = vi.fn(async () => okResponse(5))
    vi.stubGlobal('fetch', fetchMock)
    const p = pts(5, 50)
    await fetchForecasts(p, 5, async () => {}, () => {})
    await fetchForecasts(p, 5, async () => {}, () => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a used-up daily quota so the server can take over', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ reason: 'Daily API request limit exceeded' }), { status: 429 })))
    await expect(fetchForecasts(pts(3, 60), 3, async () => {}, () => {})).rejects.toBeInstanceOf(BrowserWeatherUnavailable)
  })

  it('missing() gives unknown values for every requested hour', () => {
    expect(missing(pts(1)[0]!).wind).toEqual([null, null, null])
  })
})
