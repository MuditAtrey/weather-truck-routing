// The map is created once and driven imperatively; React never re-renders it.
//
// Layers, bottom to top:
//   heat        smooth risk surface (canvas image), redrawn when the slider hour changes
//   route-*     all routes in grey; the selected one is drawn as risk-coloured segments
//   cp          checkpoint dots on the selected route (they grow as you zoom in)
//   truck       where the truck is at the slider's hour
// Risk colours come from feature-state, so changing wind mode never re-uploads geometry.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Map as MlMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type CanvasSource,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapLayerMouseEvent,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection, Point } from 'geojson'
import type { Plan, ScoreOut } from '../api/client'
import { clock, num } from '../lib/format'
import { createHeatCanvas, decodeHours } from '../lib/heatCanvas'
import { hourStore } from '../lib/hourStore'
import { DRIVERS, LEVEL_COLORS, LEVELS, UNKNOWN_COLOR, levelAt, type WindMode } from '../lib/risk'
import { routeSegments } from '../lib/segments'

setWorkerUrl(workerUrl)

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
}
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }
const US_BOUNDS: LngLatBoundsLike = [[-125, 24], [-66, 50]]
const SELECTED_LOW = '#1e3a8a' // the selected route reads as "selected" where risk is Low


/** A top-down semi (tractor + trailer) pointing north, as RGBA pixels at 2x. */
function drawSemi(): ImageData {
  const w = 48, h = 96
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const box = (x: number, y: number, bw: number, bh: number, r: number, fill: string, stroke: string, lw: number) => {
    g.beginPath()
    g.roundRect(x, y, bw, bh, r)
    g.fillStyle = fill
    g.fill()
    g.lineWidth = lw
    g.strokeStyle = stroke
    g.stroke()
  }
  box(10, 34, 28, 58, 3, '#f8fafc', '#111827', 3.2) // trailer
  box(12, 6, 24, 24, 6, '#1e3a8a', '#ffffff', 2.8) // cab
  g.fillStyle = '#bfdbfe'
  g.fillRect(16, 9, 16, 6) // windscreen
  g.fillStyle = '#111827'
  g.fillRect(21, 29, 6, 6) // fifth wheel
  return g.getImageData(0, 0, w, h)
}

const levelColor = (low: string) =>
  [
    'match', ['coalesce', ['feature-state', 'level'], -1],
    0, low, 1, LEVEL_COLORS[1], 2, LEVEL_COLORS[2], 3, LEVEL_COLORS[3], 4, LEVEL_COLORS[4],
    UNKNOWN_COLOR,
  ] as unknown as string

interface Props {
  plan: Plan | null
  score: ScoreOut | null
  mode: WindMode
  selected: number
  heatmapOn: boolean
  onSelect: (route: number) => void
  dark: boolean
}

export default function MapView({ plan, score, mode, selected, heatmapOn, onSelect, dark }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  // Bumped on every style load: switching light/dark replaces all layers, so every
  // effect below re-applies its data when this changes.
  const [ready, setReady] = useState(0)
  const [failed, setFailed] = useState(false)
  const fitted = useRef<Plan | null>(null)
  const [follow, setFollow] = useState(false)
  const followRef = useRef(false)
  followRef.current = follow
  const live = useRef({ plan, score, mode, selected, onSelect, heatmapOn, dark })
  live.current = { plan, score, mode, selected, onSelect, heatmapOn, dark }

  const heat = useMemo(() => (plan ? createHeatCanvas(plan.grid) : null), [plan])
  const heatHours = useMemo(() => (score ? decodeHours(score[mode].heatmap) : null), [score, mode])
  const segments = useMemo(() => (plan ? routeSegments(plan) : null), [plan])

  // Create the map once.
  useEffect(() => {
    let map: MlMap
    try {
      map = new MlMap({
        container: el.current!,
        style: dark ? STYLES.dark : STYLES.light,
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
    // ?debug exposes the map to automated QA (layer visibility, feature positions).
    if (new URLSearchParams(window.location.search).has('debug')) {
      ;(window as unknown as { __map: MlMap }).__map = map
    }
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    map.touchZoomRotate.disableRotation()

    // A top-down semi (tractor + trailer) pointing north; the layer rotates it to the route.
    // The truck icon is drawn synchronously (no image loading to race the style), and
    // re-added whenever a style switch clears it.
    const addSemi = () => {
      if (!map.hasImage('semi')) map.addImage('semi', drawSemi(), { pixelRatio: 2 })
    }
    map.on('styleimagemissing', (e) => {
      if (e.id === 'semi') addSemi()
    })

    map.on('style.load', () => {
      addSemi()
      // Data goes under the first label layer so place names stay readable.
      const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id
      map.addSource('routes', { type: 'geojson', data: EMPTY })
      map.addSource('segments', { type: 'geojson', data: EMPTY })
      map.addSource('checkpoints', { type: 'geojson', data: EMPTY })
      map.addSource('truck', { type: 'geojson', data: EMPTY })
      map.addSource('stops', { type: 'geojson', data: EMPTY })
      map.addLayer(
        {
          id: 'route-casing',
          type: 'line',
          source: 'routes',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': live.current.dark ? '#0b0f17' : '#ffffff', 'line-width': 6, 'line-opacity': 0.9 },
        },
        before,
      )
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'routes',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#7c8797', 'line-width': 3, 'line-opacity': 0.7 },
      })
      map.addLayer({
        id: 'route-risk',
        type: 'line',
        source: 'segments',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': levelColor(live.current.dark ? '#60a5fa' : SELECTED_LOW),
          'line-width': 3,
        },
      })
      map.addLayer({
        id: 'cp',
        type: 'circle',
        source: 'checkpoints',
        paint: {
          // Weather checkpoints: small white sample points, filled with the risk colour
          // when risk is Moderate or worse, so they never look like route beads.
          'circle-color': levelColor('#ffffff'),
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.2, 7, 3.5, 11, 5.5],
          'circle-stroke-color': live.current.dark ? '#cbd5e1' : '#334155',
          'circle-stroke-width': 1,
        },
      })
      map.addLayer({
        id: 'stops',
        type: 'circle',
        source: 'stops',
        filter: ['==', ['get', 'route'], -1],
        paint: {
          'circle-radius': 6,
          'circle-color': ['case', ['==', ['get', 'kind'], 'rest'], '#111827', '#ffffff'],
          'circle-stroke-color': ['case', ['==', ['get', 'known'], 1], '#111827', '#b45309'],
          'circle-stroke-width': 2.5,
        },
      })
      map.addLayer({
        id: 'truck',
        type: 'symbol',
        source: 'truck',
        layout: {
          'icon-image': 'semi',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 8, 1.1],
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      })
      setReady((n) => n + 1)
    })

    const popup = new Popup({ closeButton: false, closeOnClick: false, maxWidth: '260px', offset: 10 })
    const showCheckpoint = (e: MapLayerMouseEvent) => {
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
    }
    const hide = () => {
      map.getCanvas().style.cursor = ''
      popup.remove()
    }
    for (const layer of ['cp', 'route-risk']) {
      map.on('mousemove', layer, showCheckpoint)
      map.on('mouseleave', layer, hide)
    }
    map.on('mousemove', 'stops', (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      const p = live.current.plan
      if (!f || !p) return
      map.getCanvas().style.cursor = 'pointer'
      const props = f.properties as { kind: string; mile: number; at: number; name: string; spaces: number; known: number }
      const esc = (x: string) => x.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`)
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div class="pop"><b>${props.kind === 'rest' ? '10-hour rest' : '30-minute break'}</b>` +
            (props.known
              ? `<div>${esc(props.name)}${props.spaces > 0 ? ` · ${props.spaces} truck spaces` : ''}</div>`
              : '<div class="warn-text">No known truck parking here; plan ahead</div>') +
            `<div>Mile ${Math.round(props.mile).toLocaleString('en-US')} · ${clock(props.at, p.timezone)}</div>` +
            '<div class="muted">Required by hours-of-service rules</div></div>',
        )
        .addTo(map)
    })
    map.on('mouseleave', 'stops', hide)
    map.on('click', 'route-risk', (e) => {
      const r = e.features?.[0]?.properties?.route
      if (typeof r === 'number') live.current.onSelect(r)
    })

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
    for (const id of ['segments', 'checkpoints']) map.removeFeatureState({ source: id })
    src('routes').setData(plan?.routes ?? EMPTY)
    src('segments').setData(segments ?? EMPTY)
    src('checkpoints').setData(plan?.checkpoints ?? EMPTY)
    src('truck').setData(EMPTY)
    src('stops').setData({
      type: 'FeatureCollection',
      features: (plan?.routes.features ?? []).flatMap((r) =>
        (r.properties.stops ?? []).map((st) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: st.place ? [st.place.lon, st.place.lat] : [st.lon, st.lat] },
          properties: {
            route: r.properties.id,
            kind: st.kind,
            mile: st.mile,
            at: st.at,
            name: st.place?.name ?? '',
            spaces: st.place?.spaces ?? -1,
            known: st.place ? 1 : 0,
          },
        })),
      ),
    })
    // A canvas source is bound to one canvas, so each plan gets a fresh source.
    if (map.getLayer('heat')) map.removeLayer('heat')
    if (map.getSource('heat')) map.removeSource('heat')
    if (heat) {
      map.addSource('heat', { type: 'canvas', canvas: heat.canvas, coordinates: heat.coordinates, animate: false })
      map.addLayer(
        {
          id: 'heat',
          type: 'raster',
          source: 'heat',
          layout: { visibility: live.current.heatmapOn ? 'visible' : 'none' },
          // Softer at night: big bright areas are hard on dark-adapted eyes.
          paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0, 'raster-opacity': live.current.dark ? 0.6 : 0.9 },
        },
        'route-casing',
      )
    }
    if (plan && plan.routes.features.length && fitted.current !== plan) {
      fitted.current = plan
      fitRoutes(map, plan)
    }
  }, [plan, segments, heat, ready])

  // Route selection: every route shows its risk; the selected one is thick and on top.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const routeSel = ['==', ['get', 'route'], selected]
    const lowSel = live.current.dark ? '#60a5fa' : SELECTED_LOW
    const lowOther = live.current.dark ? '#64748b' : '#8b95a5'
    map.setPaintProperty('route-line', 'line-opacity', 0)
    map.setPaintProperty('route-casing', 'line-width', ['case', ['==', ['get', 'id'], selected], 10, 5] as never)
    map.setPaintProperty('route-risk', 'line-color', ['case', routeSel, levelColor(lowSel), levelColor(lowOther)] as never)
    map.setPaintProperty('route-risk', 'line-width', ['case', routeSel, ['interpolate', ['linear'], ['zoom'], 3, 4.5, 8, 6.5, 12, 8], ['interpolate', ['linear'], ['zoom'], 3, 2.5, 8, 3.5, 12, 4]] as never)
    map.setPaintProperty('route-risk', 'line-opacity', ['case', routeSel, 1, 0.75] as never)
    map.setLayoutProperty('route-risk', 'line-sort-key', ['case', routeSel, 1, 0] as never)
    map.setPaintProperty('cp', 'circle-opacity', ['case', routeSel, 1, 0.55] as never)
    map.setPaintProperty('cp', 'circle-stroke-opacity', ['case', routeSel, 1, 0.55] as never)
    map.setLayoutProperty('cp', 'circle-sort-key', ['case', routeSel, 1, 0] as never)
    map.setFilter('stops', ['==', ['get', 'route'], selected])
  }, [selected, ready, plan])

  // Checkpoint and segment colours for the current wind mode.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !plan) return
    const levels = score?.[mode].checkpoint_levels
    for (let i = 0; i < plan.checkpoints.features.length; i++) {
      const level = levels ? (levelAt(levels, i) ?? -1) : 0
      map.setFeatureState({ source: 'checkpoints', id: i + 1 }, { level })
      map.setFeatureState({ source: 'segments', id: i + 1 }, { level })
    }
  }, [plan, score, mode, ready])

  // Heatmap and truck position follow the slider without React renders.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !plan) return
    let raf = 0
    let drawn = -1
    const truckSrc = map.getSource('truck') as GeoJSONSource
    const heatSrc = map.getSource('heat') as CanvasSource | undefined
    const apply = () => {
      raf = 0
      const h = hourStore.get()
      if (heat && heatHours && h !== drawn) {
        const values = heatHours[h]
        if (values) {
          heat.draw(values)
          drawn = h
          // A paused canvas source re-uploads only when played; one frame is enough.
          heatSrc?.play()
          requestAnimationFrame(() => heatSrc?.pause())
        }
      }
      const truck = truckAt(plan, live.current.selected, plan.hours[h] ?? 0)
      truckSrc.setData(truck)
      const pos = truck.features[0]?.geometry.coordinates as [number, number] | undefined
      if (followRef.current && pos) map.easeTo({ center: pos, duration: 350 })
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
  }, [plan, heat, heatHours, ready, selected, follow])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (map.getLayer('heat')) map.setLayoutProperty('heat', 'visibility', heatmapOn ? 'visible' : 'none')
  }, [heatmapOn, ready, heat])

  // Light/dark: swap the basemap; 'style.load' then rebuilds our layers.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    map.setStyle(dark ? STYLES.dark : STYLES.light)
  }, [dark])

  if (failed) {
    return (
      <div className="map map-failed" role="img" aria-label="Map unavailable">
        <p>This browser cannot show the map (WebGL 2 is unavailable). The route table still works.</p>
      </div>
    )
  }
  return (
    <>
      <div ref={el} className="map" aria-label="Route map" />
      {plan && (
        <div className="map-buttons">
          <button
            type="button"
            onClick={() => {
              setFollow(false)
              if (mapRef.current) fitRoutes(mapRef.current, plan)
            }}
            title="Show the whole trip"
          >
            Whole trip
          </button>
          <button type="button" className={follow ? 'on' : undefined} aria-pressed={follow} onClick={() => setFollow((f) => !f)} title="Keep the truck in view as the time changes">
            Follow truck
          </button>
        </div>
      )}
    </>
  )
}

function fitRoutes(map: MlMap, plan: Plan) {
  let w = 180, s = 90, e = -180, n = -90
  for (const f of plan.routes.features)
    for (const [x, y] of f.geometry.coordinates) {
      w = Math.min(w, x!); e = Math.max(e, x!); s = Math.min(s, y!); n = Math.max(n, y!)
    }
  const wide = window.innerWidth >= 900
  map.fitBounds([[w, s], [e, n]], { padding: wide ? { top: 70, bottom: 160, left: 60, right: 60 } : 30, duration: 600 })
}

/** Where the truck is on the selected route at `t` (interpolated between checkpoints). */
function truckAt(plan: Plan, route: number, t: number): FeatureCollection<Point> {
  const cps = plan.checkpoints.features.filter((f) => f.properties.route === route)
  if (!cps.length || t < plan.departure) return { type: 'FeatureCollection', features: [] }
  let pos = cps[cps.length - 1]!.geometry.coordinates
  let bearing = 0
  for (let k = 1; k < cps.length; k++) {
    const a = cps[k - 1]!
    const b = cps[k]!
    const [ax, ay] = a.geometry.coordinates as [number, number]
    const [bx, by] = b.geometry.coordinates as [number, number]
    bearing = bearingDeg(ay, ax, by, bx)
    if (t <= b.properties.eta) {
      const span = b.properties.eta - a.properties.eta || 1
      const f = Math.max(0, Math.min(1, (t - a.properties.eta) / span))
      pos = [ax + (bx - ax) * f, ay + (by - ay) * f]
      break
    }
  }
  const feature: Feature<Point> = { type: 'Feature', geometry: { type: 'Point', coordinates: pos }, properties: { bearing } }
  return { type: 'FeatureCollection', features: [feature] }
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r)
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r)
  return (Math.atan2(y, x) / r + 360) % 360
}
