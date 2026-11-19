// One warning marker per risky stretch (High or worse) of a route, at its worst point,
// instead of a dot per sample: drivers want "where is it bad", not every reading.
import type { Feature, FeatureCollection, Point } from 'geojson'
import type { Plan, ScoreOut } from '../api/client'
import { levelAt, type WindMode } from './risk'
import { hazardSymbol } from './symbols'

export interface HazardProps {
  route: number
  cp: number // checkpoint index (feature id - 1) of the worst point
  level: number
  sym: string
}

export function hazards(plan: Plan, score: ScoreOut, mode: WindMode): FeatureCollection<Point, HazardProps> {
  const levels = score[mode].checkpoint_levels
  const features: Feature<Point, HazardProps>[] = []
  let run: { i: number; level: number; value: number } | null = null
  let runRoute = -1
  const flush = () => {
    if (run) {
      const f = plan.checkpoints.features[run.i]!
      features.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: { route: runRoute, cp: run.i, level: run.level, sym: hazardSymbol(run.level)! },
      })
    }
    run = null
  }
  plan.checkpoints.features.forEach((f, i) => {
    const route = f.properties.route
    if (route !== runRoute) {
      flush()
      runRoute = route
    }
    const level = levelAt(levels, i) ?? -1
    if (level < 2) return flush()
    const c = score.conditions[i]
    const value = Math.max(c?.gust ?? 0, c?.wind ?? 0, (c?.rain ?? 0) * 100, (c?.snow ?? 0) * 30)
    if (!run || level > run.level || (level === run.level && value > run.value)) {
      run = { i, level, value }
    }
  })
  flush()
  return { type: 'FeatureCollection', features }
}
