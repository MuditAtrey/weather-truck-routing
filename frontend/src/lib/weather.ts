// Fetches raw hourly forecasts from Open-Meteo in the browser.
//
// Open-Meteo's free tier is limited per IP address (600 location-calls a minute). Calling
// it from the browser spends the viewer's own quota instead of a shared server IP's.
// Django does all the scoring; this module only downloads and slices the numbers.
import type { PointWeather, WeatherPoint } from '../api/client'

const URL = 'https://api.open-meteo.com/v1/forecast'
const CHUNK = 250 // locations per request; each location counts as one call
const PER_MINUTE = 550 // stay under the 600/minute limit
const HOUR = 3600
const VARS = ['wind_speed_10m', 'wind_gusts_10m', 'rain', 'showers', 'snowfall'] as const

type Hourly = { time: number[] } & Record<(typeof VARS)[number], (number | null)[]>
type Location = { hourly: Hourly }

export class WeatherError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })

async function request(chunk: WeatherPoint[], forecastHours: number, signal?: AbortSignal) {
  const body = new URLSearchParams({
    latitude: chunk.map((p) => p.lat).join(','),
    longitude: chunk.map((p) => p.lon).join(','),
    hourly: VARS.join(','),
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timeformat: 'unixtime',
    forecast_hours: String(forecastHours),
  })
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URL, { method: 'POST', body, signal })
    if (res.ok) {
      const data = (await res.json()) as Location | Location[]
      return Array.isArray(data) ? data : [data]
    }
    const reason = (await res.json().catch(() => null))?.reason ?? `HTTP ${res.status}`
    if (res.status === 429 && attempt < 2 && !/daily|hourly/i.test(reason)) {
      const wait = Number(res.headers.get('Retry-After') ?? 30)
      await sleep(Math.min(65, Math.max(5, wait)) * 1000, signal)
      continue
    }
    throw new WeatherError(`Weather service: ${reason}`)
  }
}

function slice(h: Hourly, p: WeatherPoint): PointWeather {
  const t0 = h.time[0] ?? 0
  const first = Math.round((p.start - t0) / HOUR)
  const n = Math.round((p.end - p.start) / HOUR) + 1
  const pick = (arr: (number | null)[]) =>
    Array.from({ length: n }, (_, k) => {
      const v = arr[first + k]
      return v === undefined ? null : v
    })
  return {
    wind: pick(h.wind_speed_10m),
    gust: pick(h.wind_gusts_10m),
    rain: pick(h.rain),
    showers: pick(h.showers),
    snow: pick(h.snowfall),
  }
}

export async function fetchForecasts(
  points: WeatherPoint[],
  onProgress: (done: number, total: number, waitingS?: number) => void,
  signal?: AbortSignal,
): Promise<PointWeather[]> {
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR
  const lastEnd = Math.max(...points.map((p) => p.end))
  // time[0] is the current hour; request through the last hour any point needs.
  const forecastHours = Math.min(384, Math.ceil((lastEnd - nowHour) / HOUR) + 2)
  const out: PointWeather[] = []
  let spent = 0
  let windowStart = performance.now()
  onProgress(0, points.length)
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK)
    if (spent + chunk.length > PER_MINUTE) {
      const waitMs = Math.max(0, 61_000 - (performance.now() - windowStart))
      onProgress(i, points.length, Math.ceil(waitMs / 1000))
      await sleep(waitMs, signal)
      spent = 0
      windowStart = performance.now()
    }
    const locations = await request(chunk, forecastHours, signal)
    if (locations.length !== chunk.length) throw new WeatherError('Weather service returned the wrong number of locations')
    chunk.forEach((p, k) => out.push(slice(locations[k]!.hourly, p)))
    spent += chunk.length
    onProgress(Math.min(i + CHUNK, points.length), points.length)
  }
  return out
}
