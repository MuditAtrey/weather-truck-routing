// The map is created once and driven imperatively. React never re-renders it on slider
// moves: the heatmap hour arrives through hourStore and only cells whose risk level
// changed get a setFeatureState call (measured at ~2.4 ms per hour step for 1,500 cells).
import { useEffect, useRef, useState } from 'react'
import {
  Map as MlMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapLayerMouseEvent,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection, Point } from 'geojson'
import type { Plan, ScoreOut } from '../api/client'
import { clock, num } from '../lib/format'
import { hourStore } from '../lib/hourStore'
import { DRIVERS, LEVEL_COLORS, LEVELS, UNKNOWN_COLOR, levelAt, type WindMode } from '../lib/risk'

setWorkerUrl(workerUrl)

const STYLE = 'https://tiles.openfreemap.org/styles/positron'
const LABEL_LAYER = 'waterway_line_label' // first label layer in Positron: data goes under labels
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }
const US_BOUNDS: LngLatBoundsLike = [[-125, 24], [-66, 50]]

const levelColor = (fallback: string) =>
  [
    'match', ['coalesce', ['feature-state', 'level'], -1],
    0, LEVEL_COLORS[0], 1, LEVEL_COLORS[1], 2, LEVEL_COLORS[2], 3, LEVEL_COLORS[3], 4, LEVEL_COLORS[4],
    fallback,
  ] as unknown as string

interface Props {
  plan: Plan | null
  score: ScoreOut | null
  mode: WindMode
  selected: number
  heatmapOn: boolean
  onSelect: (route: number) => void
}

export default function MapView({ plan, score, mode, selected, heatmapOn, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  // Latest props for event handlers registered once.
  const live = useRef({ plan, score, mode, selected, onSelect })
  live.current = { plan, score, mode, selected, onSelect }

  // Create the map once.
  useEffect(() => {
    let map: MlMap
    try {
      map = new MlMap({
        container: el.current!,
        style: STYLE,
        bounds: US_BOUNDS,
        fitBoundsOptions: { padding: 20 },
        attributionControl: {
          compact: true,
          customAttribution: 'Weather: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>',
        },
        dragRotate: false,
        pitchWithRotate: false,
      })
    } catch {
      setFailed(true)
      return
    }
    mapRef.current = map
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    map.touchZoomRotate.disableRotation()

    map.on('load', () => {
      map.addSource('grid', { type: 'geojson', data: EMPTY })
      map.addSource('routes', { type: 'geojson', data: EMPTY })
      map.addSource('checkpoints', { type: 'geojson', data: EMPTY })
      map.addSource('truck', { type: 'geojson', data: EMPTY })
      const before = map.getLayer(LABEL_LAYER) ? LABEL_LAYER : undefined
      map.addLayer(
        {
          id: 'grid-fill',
          type: 'fill',
          source: 'grid',
          paint: {
            'fill-color': levelColor(UNKNOWN_COLOR),
            'fill-opacity': [
              'match', ['coalesce', ['feature-state', 'level'], -2],
              -2, 0, // not scored yet
              0, 0, // Low: let the basemap show through
              -1, 0.28, // unknown
              0.5,
            ],
            'fill-antialias': false,
          },
        },
        before,
      )
      map.addLayer(
        {
          id: 'route-casing',
          type: 'line',
          source: 'routes',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 },
        },
        before,
      )
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'routes',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#7c8797', 'line-width': 3, 'line-opacity': 0.75 },
      })
      map.addLayer({
        id: 'cp',
        type: 'circle',
        source: 'checkpoints',
        paint: {
          'circle-color': levelColor(UNKNOWN_COLOR),
          'circle-radius': 3,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
          'circle-opacity': 0.55,
          'circle-stroke-opacity': 0.55,
        },
      })
      map.addLayer({
        id: 'truck',
        type: 'circle',
        source: 'truck',
        paint: {
          'circle-color': '#111827',
          'circle-radius': 7,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3,
        },
      })
      setReady(true)
    })

    const popup = new Popup({ closeButton: false, closeOnClick: false, maxWidth: '260px', offset: 10 })
    map.on('mousemove', 'cp', (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      const { plan: p, score: s, mode: m } = live.current
      if (!f || !p || f.id === undefined) return
      map.getCanvas().style.cursor = 'pointer'
      const i = Number(f.id) - 1
      const props = p.checkpoints.features[i]?.properties
      if (!props) return
      const route = p.routes.features[props.route]?.properties
      const lvl = s ? levelAt(s[m].checkpoint_levels, i) : null
      const c = s?.conditions[i]
      const driver = s ? DRIVERS[s[m].checkpoint_drivers[i] ?? ''] : undefined
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div class="pop"><b>Route ${route?.name} · mile ${props.mile.toLocaleString('en-US')}</b>` +
            `<div>ETA ${clock(props.eta, p.timezone)}</div>` +
            (s
              ? `<div class="pop-risk" style="--c:${lvl === null ? UNKNOWN_COLOR : LEVEL_COLORS[lvl]}">${lvl === null ? 'Unknown (no forecast)' : LEVELS[lvl]}${driver && lvl ? ` · ${driver}` : ''}</div>` +
                `<div>Wind ${num(c?.wind, 0, 'mph')} · gusts ${num(c?.gust, 0, 'mph')}</div>` +
                `<div>Rain ${num(c?.rain, 2, 'in/hr')} · snow ${num(c?.snow, 2, 'in/hr')}</div>`
              : '<div>Loading weather…</div>') +
            '</div>',
        )
        .addTo(map)
    })
    map.on('mouseleave', 'cp', () => {
      map.getCanvas().style.cursor = ''
      popup.remove()
    })
    map.on('click', 'cp', (e) => {
      const i = Number(e.features?.[0]?.id) - 1
      const r = live.current.plan?.checkpoints.features[i]?.properties.route
      if (r !== undefined) live.current.onSelect(r)
    })
    map.on('click', 'route-line', (e) => {
      const r = e.features?.[0]?.properties?.id
      if (typeof r === 'number') live.current.onSelect(r)
    })
    map.on('mouseenter', 'route-line', () => (map.getCanvas().style.cursor = 'pointer'))
    map.on('mouseleave', 'route-line', () => (map.getCanvas().style.cursor = ''))

    return () => {
      popup.remove()
      map.remove()
      mapRef.current = null
    }
  }, [])

  // New plan: replace data and frame the routes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const src = (id: string) => map.getSource(id) as GeoJSONSource
    for (const id of ['grid', 'checkpoints']) map.removeFeatureState({ source: id })
    src('routes').setData(plan?.routes ?? EMPTY)
    src('checkpoints').setData(plan?.checkpoints ?? EMPTY)
    src('grid').setData(plan?.grid ?? EMPTY)
    src('truck').setData(EMPTY)
    if (plan && plan.routes.features.length) {
      let w = 180, s = 90, e = -180, n = -90
      for (const f of plan.routes.features)
        for (const [x, y] of f.geometry.coordinates) {
          if (x! < w) w = x!
          if (x! > e) e = x!
          if (y! < s) s = y!
          if (y! > n) n = y!
        }
      const wide = window.innerWidth >= 900
      map.fitBounds([[w, s], [e, n]], {
        padding: wide ? { top: 60, bottom: 130, left: 60, right: 60 } : 30,
        duration: 600,
      })
    }
  }, [plan, ready])

  // Route selection: emphasise one route and its checkpoints.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const isSel = ['==', ['get', 'id'], selected]
    const cpSel = ['==', ['get', 'route'], selected]
    map.setPaintProperty('route-line', 'line-color', ['case', isSel, '#1e3a8a', '#7c8797'] as never)
    map.setPaintProperty('route-line', 'line-width', ['case', isSel, 5, 3] as never)
    map.setPaintProperty('route-line', 'line-opacity', ['case', isSel, 1, 0.6] as never)
    map.setPaintProperty('route-casing', 'line-width', ['case', isSel, 9, 6] as never)
    map.setLayoutProperty('route-line', 'line-sort-key', ['case', isSel, 1, 0] as never)
    map.setLayoutProperty('route-casing', 'line-sort-key', ['case', isSel, 1, 0] as never)
    map.setPaintProperty('cp', 'circle-radius', ['case', cpSel, 6, 3] as never)
    map.setPaintProperty('cp', 'circle-opacity', ['case', cpSel, 1, 0.5] as never)
    map.setPaintProperty('cp', 'circle-stroke-opacity', ['case', cpSel, 1, 0.5] as never)
    map.setPaintProperty('cp', 'circle-stroke-width', [
      'case', ['all', cpSel, ['==', ['feature-state', 'level'], 4]], 3, cpSel, 1.5, 1,
    ] as never)
    map.setPaintProperty('cp', 'circle-stroke-color', [
      'case', ['==', ['feature-state', 'level'], 4], '#111827', '#ffffff',
    ] as never)
    map.setLayoutProperty('cp', 'circle-sort-key', ['case', cpSel, 1, 0] as never)
  }, [selected, ready, plan])

  // Checkpoint colours for the current wind mode.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !plan || !score) return
    const levels = score[mode].checkpoint_levels
    for (let i = 0; i < plan.checkpoints.features.length; i++) {
      map.setFeatureState({ source: 'checkpoints', id: i + 1 }, { level: levelAt(levels, i) ?? -1 })
    }
  }, [plan, score, mode, ready])

  // Heatmap and truck position follow the slider without React renders.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !plan) return
    const nCells = plan.grid.features.length
    const last = new Int8Array(nCells).fill(-3)
    let raf = 0
    const truckSrc = map.getSource('truck') as GeoJSONSource

    const apply = () => {
      raf = 0
      const h = hourStore.get()
      if (score) {
        const levels = score[mode].heatmap[h] ?? ''
        for (let i = 0; i < nCells; i++) {
          const v = levelAt(levels, i) ?? -1
          if (v !== last[i]) {
            last[i] = v
            map.setFeatureState({ source: 'grid', id: i + 1 }, { level: v })
          }
        }
      }
      truckSrc.setData(truckAt(plan, live.current.selected, plan.hours[h] ?? 0))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply)
    }
    apply()
    const unsub = hourStore.subscribe(schedule)
    return () => {
      unsub()
      cancelAnimationFrame(raf)
    }
  }, [plan, score, mode, ready, selected])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    map.setLayoutProperty('grid-fill', 'visibility', heatmapOn ? 'visible' : 'none')
  }, [heatmapOn, ready])

  if (failed) {
    return (
      <div className="map map-failed" role="img" aria-label="Map unavailable">
        <p>This browser cannot show the map (WebGL 2 is unavailable). The route table still works.</p>
      </div>
    )
  }
  return <div ref={el} className="map" aria-label="Route map" />
}

/** Where the truck is on the selected route at `t` (interpolated between checkpoints). */
function truckAt(plan: Plan, route: number, t: number): FeatureCollection<Point> {
  const cps = plan.checkpoints.features.filter((f) => f.properties.route === route)
  if (!cps.length || t < plan.departure) return { type: 'FeatureCollection', features: [] }
  let pos = cps[cps.length - 1]!.geometry.coordinates
  for (let k = 1; k < cps.length; k++) {
    const a = cps[k - 1]!
    const b = cps[k]!
    if (t <= b.properties.eta) {
      const span = b.properties.eta - a.properties.eta || 1
      const f = Math.max(0, Math.min(1, (t - a.properties.eta) / span))
      const [ax, ay] = a.geometry.coordinates as [number, number]
      const [bx, by] = b.geometry.coordinates as [number, number]
      pos = [ax + (bx - ax) * f, ay + (by - ay) * f]
      break
    }
  }
  const feature: Feature<Point> = { type: 'Feature', geometry: { type: 'Point', coordinates: pos }, properties: {} }
  return { type: 'FeatureCollection', features: [feature] }
}
