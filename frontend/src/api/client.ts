// Typed access to the Django API. Types come from the backend's OpenAPI schema
// (`npm run gen:api`); only the GeoJSON payloads are narrowed by hand here.
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson'
import type { components } from './schema'

type S = components['schemas']
export type PlanIn = S['PlanIn']
export type ScoreOut = S['ScoreOut']
export type ModeResult = S['ModeResult']
export type PointWeather = S['PointWeather']
export type WeatherPoint = S['WeatherPoint']
export type RouteScore = S['RouteScore']

export interface RouteProps {
  id: number
  name: string
  distance_mi: number
  drive_s: number
  trip_s: number
  source: 'valhalla' | 'osrm'
  via: boolean
  warnings: string[]
}
export interface CheckpointProps {
  route: number
  index: number
  mile: number
  represented_mi: number
  eta: number
  drive_s: number
}

export type Plan = Omit<S['PlanOut'], 'routes' | 'checkpoints' | 'grid'> & {
  routes: FeatureCollection<LineString, RouteProps>
  checkpoints: FeatureCollection<Point, CheckpointProps>
  grid: FeatureCollection<Polygon, { cell: number }>
}
export type RouteFeature = Feature<LineString, RouteProps>

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError('offline', 'Could not reach the server. Check your connection.', 0)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 422 && Array.isArray(body?.detail)) {
      throw new ApiError('invalid', 'Some trip details are invalid. Check the form.', 422)
    }
    if (res.status === 429) throw new ApiError('throttled', 'Too many requests. Wait a minute and try again.', 429)
    throw new ApiError(body?.code ?? 'error', body?.detail ?? `Server error (${res.status})`, res.status)
  }
  return body as T
}

export const api = {
  health: (signal?: AbortSignal) => call<{ status: string }>('/health', { signal }),
  timezone: (lat: number, lon: number, signal?: AbortSignal) =>
    call<{ timezone: string }>(`/timezone?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, { signal }),
  plan: (body: PlanIn, signal?: AbortSignal) =>
    call<Plan>('/plan', { method: 'POST', body: JSON.stringify(body), signal }),
  score: (token: string, weather: PointWeather[], signal?: AbortSignal) =>
    call<ScoreOut>('/score', { method: 'POST', body: JSON.stringify({ token, weather }), signal }),
}
