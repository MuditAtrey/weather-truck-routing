// Fetches raw hourly forecasts from Open-Meteo in the browser.
//
// Open-Meteo's free tier is limited per IP address. Calling it from the browser spends
// the viewer's own quota instead of a serverless host's shared one. Django does all the
// scoring; this module only downloads and slices the numbers.
//
// Limits (measured): up to 1,000 locations per request; each location costs one call;
// 600 calls a minute, but a single request that goes over is still served, and only the
// next one is refused. So: one big request when possible, and wait out the minute only
// before a second one.
import type { PointWeather, WeatherPoint } from '../api/client'

const URL = 'https://api.open-meteo.com/v1/forecast'
const MAX_PER_REQUEST = 1000
const PER_MINUTE = 600
const HOUR = 3600
const VARS = ['wind_speed_10m', 'wind_gusts_10m', 'rain', 'showers', 'snowfall'] as const

type Hourly = { time: number[] } & Record<(typeof VARS)[number], (number | null)[]>
type Location = { hourly: Hourly }

export class WeatherError extends Error {}
/** The browser cannot download forecasts (quota used up, blocked, offline). */
export class BrowserWeatherUnavailable extends WeatherError {}

// Forecasts already downloaded in this tab, by location. Re-planning the same trip (a
// different weight, interval or departure) reuses them instead of spending quota again.
const CACHE_MS = 30 * 60_000
const cache = new Map<string, { at: number; hourly: Hourly }>()
const keyOf = (p: WeatherPoint) => `${p.lat},${p.lon}`

function cached(p: WeatherPoint): Hourly | null {
  const hit = cache.get(keyOf(p))
  if (!hit || Date.now() - hit.at > CACHE_MS) return null
  const t = hit.hourly.time
  return t.length && t[0]! <= p.start && t[t.length - 1]! >= p.end ? hit.hourly : null
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })

async function request(
  chunk: WeatherPoint[],
  forecastHours: number,
  onWait: (seconds: number) => void,
  signal?: AbortSignal,
) {
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
    let res: Response
    try {
      res = await fetch(URL, { method: 'POST', body, signal })
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      throw new BrowserWeatherUnavailable('Could not reach the weather service from this browser.')
    }
    if (res.ok) {
      const data = (await res.json()) as Location | Location[]
      return Array.isArray(data) ? data : [data]
    }
    const reason: string = (await res.json().catch(() => null))?.reason ?? `HTTP ${res.status}`
    const retryAfter = Number(res.headers.get('Retry-After') ?? 30)
    if (res.status === 429 && attempt < 2 && !/daily|hourly/i.test(reason)) {
      // Per-minute limit: wait it out, visibly.
      const wait = Math.min(65, Math.max(5, retryAfter))
      onWait(wait)
      await sleep(wait * 1000, signal)
      continue
    }
    if (res.status === 429) {
      throw new BrowserWeatherUnavailable(`This network's ${/daily/i.test(reason) ? 'daily' : 'hourly'} weather quota is used up.`)
    }
    throw new WeatherError(`Weather service error: ${reason}`)
  }
}

function hoursOf(p: WeatherPoint) {
  return Math.round((p.end - p.start) / HOUR) + 1
}

function slice(h: Hourly, p: WeatherPoint): PointWeather {
  const first = Math.round((p.start - (h.time[0] ?? 0)) / HOUR)
  const n = hoursOf(p)
  const pick = (arr: (number | null)[]) => Array.from({ length: n }, (_, k) => arr[first + k] ?? null)
  return {
    wind: pick(h.wind_speed_10m),
    gust: pick(h.wind_gusts_10m),
    rain: pick(h.rain),
    showers: pick(h.showers),
    snow: pick(h.snowfall),
  }
}

/** Placeholder for a point not fetched yet: all values unknown. */
export function missing(p: WeatherPoint): PointWeather {
  const nulls = () => Array.from({ length: hoursOf(p) }, () => null)
  return { wind: nulls(), gust: nulls(), rain: nulls(), showers: nulls(), snow: nulls() }
}

/**
 * Downloads forecasts for `points` in as few requests as possible. `onBatch` receives
 * the full array (unfetched points filled with unknowns) after each request, so the
 * caller can score routes before the heatmap cells arrive.
 */
export async function fetchForecasts(
  points: WeatherPoint[],
  firstBatch: number,
  onBatch: (weather: PointWeather[], done: number) => Promise<void>,
  onWait: (seconds: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR
  const lastEnd = Math.max(...points.map((p) => p.end))
  const forecastHours = Math.min(384, Math.ceil((lastEnd - nowHour) / HOUR) + 2)
  const weather = points.map(missing)
  // Fill what this tab already has; only download the rest.
  const need: number[] = []
  points.forEach((p, i) => {
    const hit = cached(p)
    if (hit) weather[i] = slice(hit, p)
    else need.push(i)
  })
  if (!need.length) {
    await onBatch(weather, points.length)
    return
  }
  const todo = need.map((i) => points[i]!)
  const firstTodo = need.filter((i) => i < firstBatch).length

  // Everything in one request if it fits; otherwise checkpoints first, then the rest.
  const first = Math.max(1, Math.min(firstTodo || todo.length, MAX_PER_REQUEST))
  const cuts =
    todo.length <= MAX_PER_REQUEST
      ? [0, todo.length]
      : [0, first].concat(
          Array.from({ length: Math.ceil((todo.length - first) / MAX_PER_REQUEST) }, (_, k) =>
            Math.min(todo.length, first + (k + 1) * MAX_PER_REQUEST),
          ),
        )
  let windowStart = 0
  let spent = 0
  for (let k = 0; k + 1 < cuts.length; k++) {
    const chunk = todo.slice(cuts[k], cuts[k + 1])
    if (spent >= PER_MINUTE || (spent > 0 && spent + chunk.length > PER_MINUTE)) {
      const waitMs = Math.max(0, 61_000 - (performance.now() - windowStart))
      onWait(Math.ceil(waitMs / 1000))
      await sleep(waitMs, signal)
      spent = 0
    }
    if (spent === 0) windowStart = performance.now()
    const locations = await request(chunk, forecastHours, onWait, signal)
    if (locations.length !== chunk.length) throw new WeatherError('Weather service returned the wrong number of locations')
    chunk.forEach((p, i) => {
      const hourly = locations[i]!.hourly
      cache.set(keyOf(p), { at: Date.now(), hourly })
      weather[need[cuts[k]! + i]!] = slice(hourly, p)
    })
    spent += chunk.length
    await onBatch(weather, k + 2 >= cuts.length ? points.length : 0)
  }
}
