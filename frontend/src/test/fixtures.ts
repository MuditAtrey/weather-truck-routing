// A small synthetic plan: one straight route heading north-east with 4 HOS stops.
import type { Plan, RouteFeature, ScoreOut } from '../api/client'

export function makePlan(): Plan {
  const n = 400
  const coords = Array.from({ length: n + 1 }, (_, k) => [-100 + (k / n) * 20, 35 + (k / n) * 8])
  const stops = [
    { kind: 'break' as const, mile: 450, place: { name: "Love's Travel Stop", kind: 'truck_stop' as const, road: null, spaces: null, off_route_mi: 0.3 } },
    { kind: 'rest' as const, mile: 640, place: { name: 'Holly Rest Area', kind: 'public' as const, road: 'US-40', spaces: 6, off_route_mi: 0.1 } },
    { kind: 'break' as const, mile: 1100, place: null },
    { kind: 'rest' as const, mile: 1290, place: { name: 'Pilot Travel Center', kind: 'truck_stop' as const, road: null, spaces: 80, off_route_mi: 0.5 } },
  ].map((s, i) => {
    const c = coords[Math.round((s.mile / 1500) * n)]!
    return {
      kind: s.kind,
      lat: c[1]!,
      lon: c[0]!,
      mile: s.mile,
      at: 1_800_000_000 + i * 20000,
      duration_s: s.kind === 'rest' ? 36000 : 1800,
      early_min: 10,
      place: s.place ? { ...s.place, lat: c[1]! + 0.001, lon: c[0]! + 0.001, source: 'OpenStreetMap' } : null,
    }
  })
  const route: RouteFeature = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { id: 0, name: 'A', distance_mi: 1500, drive_s: 90000, trip_s: 135000, source: 'valhalla', via: false, warnings: [], stops },
  }
  const cps = [0, 300, 600, 900, 1200, 1500].map((mile, i) => {
    const c = coords[Math.round((mile / 1500) * n)]!
    return {
      type: 'Feature' as const,
      id: i + 1,
      geometry: { type: 'Point' as const, coordinates: c },
      properties: { route: 0, index: i, mile, represented_mi: 300, eta: 1_800_000_000 + i * 18000, drive_s: i * 18000 },
    }
  })
  return {
    token: 't',
    timezone: 'America/Chicago',
    departure: 1_800_000_000,
    hours: Array.from({ length: 49 }, (_, k) => 1_800_000_000 + k * 3600),
    router: { provider: 'valhalla', profile: 'truck', fallback_reason: null, legs: 2 },
    warnings: [],
    routes: { type: 'FeatureCollection', features: [route] },
    checkpoints: { type: 'FeatureCollection', features: cps },
    grid: { type: 'FeatureCollection', features: [] },
    checkpoint_points: 6,
    weather_points: [],
  }
}

export function makeScore(levels: string, gusts: number[]): ScoreOut {
  const mode = {
    checkpoint_levels: levels,
    checkpoint_drivers: 'w'.repeat(levels.length),
    routes: [],
    ranking: { order: [0], recommended: 0, status: 'ok' as const, reasons: {} },
    heatmap: [],
  }
  return {
    server_filled: 0,
    server_weather_ok: true,
    server_weather_error: '',
    conditions: gusts.map((g) => ({ wind: g / 2, gust: g, rain: 0, snow: 0 })),
    sustained: mode,
    gust: mode,
  }
}
