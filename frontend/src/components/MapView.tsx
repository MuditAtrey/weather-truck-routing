// The map is created once and driven imperatively; React never re-renders it.
//
// Layers, bottom to top:
//   heat           smooth risk surface (canvas image), off by default, redrawn per hour
//   other-*        the alternative routes: a plain grey line, so grey only ever means
//                  "another route"
//   sel-casing     dark outline that keeps the selected route readable on any basemap
//   sel-line       the selected route coloured by risk; the part behind the truck fades
//   sel-nt         white dashes over No Travel stretches (not colour alone)
//   cp             checkpoint dots, only when zoomed in and switched on
//   marks          start, destination, stops and one warning per risky stretch, drawn
//                  with the same symbols as the timeline, itinerary and key
//   truck          where the truck is at the slider's time, on the road, facing its way
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
  type MapGeoJSONFeature,
  type MapLayerMouseEvent,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection, Point } from 'geojson'
import type { Plan, ScoreOut } from '../api/client'
import { stopPoint } from '../lib/export'
import { clock, num } from '../lib/format'
import { hazards } from '../lib/hazards'
import { createHeatCanvas, decodeHours } from '../lib/heatCanvas'
import { hourStore } from '../lib/hourStore'
import {
  DRIVERS,
  LEVEL_COLORS,
  LEVELS,
  LOW_DARK,
  OTHER_ROUTE,
  OTHER_ROUTE_DARK,
  UNKNOWN_COLOR,
  levelAt,
  type WindMode,
} from '../lib/risk'
import { routeSegments } from '../lib/segments'
import { ALL_SYMBOLS, MAP_SIZES, SYMBOL_LABEL, hazardSymbol, stopSymbol, symbolImage, symbolSvg, type SymbolId } from '../lib/symbols'
import { createTrack } from '../lib/track'

setWorkerUrl(workerUrl)

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
}
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }
const US_BOUNDS: LngLatBoundsLike = [[-125, 24], [-66, 50]]
/** Draw order of the symbols, top first (a higher sort key draws on top). */
const SORT: Partial<Record<SymbolId, number>> = { end: 7, start: 6, notravel: 5, rest: 4, 'rest-unknown': 4, break: 3, 'break-unknown': 3, severe: 2, high: 2 }
const TWEEN_MS = 420
const FOLLOW_ZOOM = 7.5

const levelColor = (low: string) =>
  [
    'match', ['coalesce', ['feature-state', 'level'], -1],
    0, low, 1, LEVEL_COLORS[1], 2, LEVEL_COLORS[2], 3, LEVEL_COLORS[3], 4, LEVEL_COLORS[4],
    UNKNOWN_COLOR,
  ] as unknown as string

const esc = (x: string) => x.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`)

interface MarkProps {
  route: number
  sym: SymbolId
  sort: number
  kind: 'start' | 'end' | 'stop' | 'hazard'
  ref: number // stop index for stops, checkpoint index for hazards
}

interface Props {
  plan: Plan | null
  score: ScoreOut | null
  mode: WindMode
  selected: number
  labels: [string, string]
  heatmapOn: boolean
  checkpointsOn: boolean
  follow: boolean
  onFollow: (on: boolean) => void
  onSelect: (route: number) => void
  onMode: (m: WindMode) => void
  onHeatmap: (on: boolean) => void
  onCheckpoints: (on: boolean) => void
  dark: boolean
}

export default function MapView(props: Props) {
  const { plan, score, mode, selected, heatmapOn, checkpointsOn, follow, onFollow, dark } = props
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  // Bumped on every style load: switching light/dark replaces all layers, so every
  // effect below re-applies its data when this changes.
  const [ready, setReady] = useState(0)
  const [failed, setFailed] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const fitted = useRef<Plan | null>(null)
  const followEaseUntil = useRef(0)
  const live = useRef(props)
  live.current = props

  const heat = useMemo(() => (plan ? createHeatCanvas(plan.grid) : null), [plan])
  const heatHours = useMemo(() => (score ? decodeHours(score[mode].heatmap) : null), [score, mode])
  const segments = useMemo(() => (plan ? routeSegments(plan) : null), [plan])
  const track = useMemo(() => (plan ? createTrack(plan, selected) : null), [plan, selected])

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

    // Symbols are drawn synchronously (nothing to race the style load) and re-added
    // whenever a style switch clears them.
    const addSymbol = (id: SymbolId) => {
      if (!map.hasImage(id)) map.addImage(id, symbolImage(id, MAP_SIZES[id]), { pixelRatio: 2 })
    }
    map.on('styleimagemissing', (e) => {
      if ((ALL_SYMBOLS as string[]).includes(e.id)) addSymbol(e.id as SymbolId)
    })

    map.on('style.load', () => {
      ALL_SYMBOLS.forEach(addSymbol)
      const dk = live.current.dark
      // Lines go under the first label layer so place names stay readable.
      const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id
      for (const id of ['routes', 'segments', 'checkpoints', 'marks', 'truck']) map.addSource(id, { type: 'geojson', data: EMPTY })
      const round = { 'line-join': 'round', 'line-cap': 'round' } as const
      const width = (z4: number, z8: number, z12: number) =>
        ['interpolate', ['linear'], ['zoom'], 4, z4, 8, z8, 12, z12] as unknown as number
      map.addLayer({
        id: 'other-casing', type: 'line', source: 'routes', layout: round,
        paint: { 'line-color': dk ? '#0b0f17' : '#ffffff', 'line-width': width(5, 6, 7), 'line-opacity': 0.9 },
      }, before)
      map.addLayer({
        id: 'other-line', type: 'line', source: 'segments', layout: round,
        paint: { 'line-color': dk ? OTHER_ROUTE_DARK : OTHER_ROUTE, 'line-width': width(3, 4, 5) },
      }, before)
      map.addLayer({
        id: 'sel-casing', type: 'line', source: 'routes', layout: round,
        paint: { 'line-color': dk ? '#f9fafb' : '#1f2937', 'line-width': width(8, 10, 12), 'line-opacity': dk ? 0.55 : 0.85 },
      }, before)
      map.addLayer({
        id: 'sel-line', type: 'line', source: 'segments', layout: round,
        paint: {
          // The road already driven turns grey, like turn-by-turn apps' vanishing route line.
          'line-color': ['case', ['boolean', ['feature-state', 'passed'], false], dk ? '#4b5563' : '#b8bec8', levelColor(dk ? LOW_DARK : LEVEL_COLORS[0])] as unknown as string,
          'line-width': width(5, 7, 9),
        },
      }, before)
      map.addLayer({
        id: 'sel-nt', type: 'line', source: 'segments', layout: { 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': width(1.5, 2, 2.5),
          'line-dasharray': [2, 2],
          'line-opacity': ['case', ['==', ['coalesce', ['feature-state', 'level'], -1], 4], 1, 0] as unknown as number,
        },
      }, before)
      // Invisible, wide hit area: hovering anywhere near a route shows the forecast there.
      map.addLayer({
        id: 'hit', type: 'line', source: 'segments', layout: round,
        paint: { 'line-color': '#000000', 'line-width': 18, 'line-opacity': 0 },
      }, before)
      map.addLayer({
        id: 'cp', type: 'circle', source: 'checkpoints', minzoom: 7,
        layout: { visibility: live.current.checkpointsOn ? 'visible' : 'none' },
        paint: {
          'circle-color': ['case', ['boolean', ['feature-state', 'passed'], false], dk ? '#4b5563' : '#b8bec8', levelColor(dk ? LOW_DARK : LEVEL_COLORS[0])] as unknown as string,
          'circle-radius': 4,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
      })
      map.addLayer({
        id: 'marks', type: 'symbol', source: 'marks',
        layout: {
          'icon-image': ['get', 'sym'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.85, 10, 1.1],
          'symbol-sort-key': ['get', 'sort'],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      })
      map.addLayer({
        id: 'truck', type: 'symbol', source: 'truck',
        layout: {
          'icon-image': 'truck',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.9, 8, 1.1],
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      })
      setReady((n) => n + 1)
    })

    const popup = new Popup({ closeButton: false, closeOnClick: false, maxWidth: '280px', offset: 12 })

    const checkpointHtml = (i: number, title?: string) => {
      const { plan: p, score: s, mode: m } = live.current
      const props = p?.checkpoints.features[i]?.properties
      if (!p || !props) return ''
      const route = p.routes.features[props.route]?.properties
      const lvl = s ? levelAt(s[m].checkpoint_levels, i) : null
      const c = s?.conditions[i]
      const driver = s ? DRIVERS[s[m].checkpoint_drivers[i] ?? ''] : undefined
      const sym = lvl !== null ? hazardSymbol(lvl) : null
      return (
        `<div class="pop"><div class="pop-head">${sym ? symbolSvg(sym, 18) : ''}<b>${esc(title ?? `Route ${route?.name}`)}</b></div>` +
        `<div>Mile ${Math.round(props.mile).toLocaleString('en-US')} · truck there ${clock(props.eta, p.timezone)}</div>` +
        (s
          ? `<div class="pop-risk" style="--c:${lvl === null ? UNKNOWN_COLOR : LEVEL_COLORS[lvl]}">${lvl === null ? 'No forecast' : LEVELS[lvl]}${driver && lvl ? ` · ${driver}` : ''}</div>` +
            `<div>Gusts ${num(c?.gust, 0, 'mph')} · wind ${num(c?.wind, 0, 'mph')}</div>` +
            `<div>Rain ${num(c?.rain, 2, 'in/hr')} · snow ${num(c?.snow, 2, 'in/hr')}</div>`
          : '<div>Loading weather…</div>') +
        '</div>'
      )
    }

    const markHtml = (f: MapGeoJSONFeature) => {
      const { plan: p, labels } = live.current
      if (!p) return ''
      const m = f.properties as MarkProps
      if (m.kind === 'hazard') return checkpointHtml(m.ref, SYMBOL_LABEL[m.sym])
      const route = p.routes.features[m.route]?.properties
      if (!route) return ''
      if (m.kind === 'start' || m.kind === 'end') {
        const at = m.kind === 'start' ? p.departure : p.departure + route.trip_s
        return (
          `<div class="pop"><div class="pop-head">${symbolSvg(m.sym, 18)}<b>${esc(labels[m.kind === 'start' ? 0 : 1] || SYMBOL_LABEL[m.sym])}</b></div>` +
          `<div>${m.kind === 'start' ? 'Leave' : 'Arrive'} ${clock(at, p.timezone)}</div></div>`
        )
      }
      const st = route.stops[m.ref]
      if (!st) return ''
      return (
        `<div class="pop"><div class="pop-head">${symbolSvg(m.sym, 18)}<b>${st.kind === 'rest' ? '10-hour rest' : '30-minute break'}</b></div>` +
        (st.place
          ? `<div>${esc(st.place.name)}${st.place.spaces ? ` · ${st.place.spaces} truck spaces` : ''}</div>`
          : '<div class="warn-text">No known truck parking here; plan ahead</div>') +
        `<div>Mile ${Math.round(st.mile).toLocaleString('en-US')} · ${clock(st.at, p.timezone)}</div>` +
        '<div class="muted">Required by hours-of-service rules</div></div>'
      )
    }

    const show = (e: MapLayerMouseEvent, html: string) => {
      if (!html) return
      map.getCanvas().style.cursor = 'pointer'
      popup.setLngLat(e.lngLat).setHTML(html).addTo(map)
    }
    const hide = () => {
      map.getCanvas().style.cursor = ''
      popup.remove()
    }
    // Marks win over the line under them.
    const onMark = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (f) show(e, markHtml(f))
    }
    const onLine = (e: MapLayerMouseEvent) => {
      if (map.queryRenderedFeatures(e.point, { layers: ['marks'] }).length) return
      const f = e.features?.[0]
      if (f?.id !== undefined) show(e, checkpointHtml(Number(f.id) - 1))
    }
    map.on('mousemove', 'marks', onMark)
    map.on('mousemove', 'hit', onLine)
    map.on('mousemove', 'cp', onLine)
    map.on('mouseleave', 'marks', hide)
    map.on('mouseleave', 'hit', hide)
    map.on('click', 'hit', (e) => {
      // A grey route right under the pointer wins, even where it runs beside the selected one.
      const { x, y } = e.point
      const other = map.queryRenderedFeatures([[x - 5, y - 5], [x + 5, y + 5]], { layers: ['other-line'] })[0]
      const r = other?.properties?.route
      if (typeof r === 'number' && r !== live.current.selected) live.current.onSelect(r)
      else onLine(e) // touch screens have no hover: a tap shows the forecast
    })
    map.on('click', 'marks', onMark)
    // Panning by hand means "let me look around": stop following the truck.
    map.on('dragstart', () => live.current.follow && live.current.onFollow(false))

    return () => {
      popup.remove()
      map.remove()
      mapRef.current = null
    }
  }, [])

  // New plan: replace geometry and frame the routes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const src = (id: string) => map.getSource(id) as GeoJSONSource
    for (const id of ['segments', 'checkpoints']) map.removeFeatureState({ source: id })
    src('routes').setData(plan?.routes ?? EMPTY)
    src('segments').setData(segments ?? EMPTY)
    src('checkpoints').setData(plan?.checkpoints ?? EMPTY)
    src('truck').setData(EMPTY)
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
          // A backdrop, not the main event: the route line has to stay the loudest thing.
          paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0, 'raster-opacity': live.current.dark ? 0.35 : 0.45 },
        },
        'other-casing',
      )
    }
    if (plan && plan.routes.features.length && fitted.current !== plan) {
      fitted.current = plan
      fitRoutes(map, plan)
    }
  }, [plan, segments, heat, ready])

  // Route selection: the selected route is drawn by the sel-* layers, the rest in grey.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const isSel = ['==', ['get', 'route'], selected]
    const notSel = ['!=', ['get', 'route'], selected]
    map.setFilter('other-casing', ['!=', ['get', 'id'], selected] as never)
    map.setFilter('other-line', notSel as never)
    map.setFilter('sel-casing', ['==', ['get', 'id'], selected] as never)
    map.setFilter('sel-line', isSel as never)
    map.setFilter('sel-nt', isSel as never)
    map.setFilter('cp', isSel as never)
    map.setFilter('marks', isSel as never)
  }, [selected, ready, plan])

  // Start, destination, stops and hazard markers for every route (filtered to the selected one).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const features: Feature<Point, MarkProps>[] = []
    const add = (coordinates: number[], p: Omit<MarkProps, 'sort'>) =>
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { ...p, sort: SORT[p.sym] ?? 1 } })
    for (const r of plan?.routes.features ?? []) {
      const id = r.properties.id
      const c = r.geometry.coordinates
      add(c[0]!, { route: id, sym: 'start', kind: 'start', ref: 0 })
      add(c[c.length - 1]!, { route: id, sym: 'end', kind: 'end', ref: 0 })
      r.properties.stops.forEach((st, k) => {
        const [lat, lon] = stopPoint(st)
        add([lon, lat], { route: id, sym: stopSymbol(st.kind, !!st.place), kind: 'stop', ref: k })
      })
    }
    if (plan && score) {
      for (const h of hazards(plan, score, mode).features) {
        add(h.geometry.coordinates, { route: h.properties.route, sym: h.properties.sym as SymbolId, kind: 'hazard', ref: h.properties.cp })
      }
    }
    ;(map.getSource('marks') as GeoJSONSource).setData({ type: 'FeatureCollection', features })
  }, [plan, score, mode, ready])

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

  // Heatmap and truck follow the slider without React renders. The truck glides between
  // hours instead of jumping, so playing the forecast looks like a drive.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !plan || !track) return
    let raf = 0
    let drawn = -1
    let shown = plan.hours[hourStore.get()] ?? plan.departure
    let from = shown
    let target = shown
    let startedAt = 0
    let passed = new Set<number>()
    const cps = plan.checkpoints.features.map((f, i) => ({ i, mile: f.properties.mile, route: f.properties.route })).filter((c) => c.route === track.route)
    const truckSrc = map.getSource('truck') as GeoJSONSource
    const heatSrc = map.getSource('heat') as CanvasSource | undefined

    const place = (t: number) => {
      const s = track.at(t)
      truckSrc.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: s.pos }, properties: { bearing: s.bearing } }],
      })
      // Fade the road already driven (not once arrived: then the whole trip matters again).
      const next = new Set<number>()
      if (s.status === 'driving' || s.status === 'stopped') for (const c of cps) if (c.mile < s.mile - 1) next.add(c.i)
      const mark = (i: number, v: boolean) => {
        map.setFeatureState({ source: 'segments', id: i + 1 }, { passed: v })
        map.setFeatureState({ source: 'checkpoints', id: i + 1 }, { passed: v })
      }
      for (const i of passed) if (!next.has(i)) mark(i, false)
      for (const i of next) if (!passed.has(i)) mark(i, true)
      passed = next
      const f = live.current
      if (f.follow && performance.now() > followEaseUntil.current) map.jumpTo({ center: s.pos })
    }

    const frame = (now: number) => {
      raf = 0
      const k = Math.min(1, (now - startedAt) / TWEEN_MS)
      shown = from + (target - from) * (k < 1 ? 1 - (1 - k) * (1 - k) : 1)
      place(shown)
      if (k < 1) raf = requestAnimationFrame(frame)
    }
    const onHour = () => {
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
      from = shown
      target = plan.hours[h] ?? plan.departure
      startedAt = performance.now()
      if (!raf) raf = requestAnimationFrame(frame)
    }
    place(shown)
    onHour()
    const unsub = hourStore.subscribe(onHour)
    return () => {
      unsub()
      cancelAnimationFrame(raf)
      for (const i of passed) {
        map.setFeatureState({ source: 'segments', id: i + 1 }, { passed: false })
        map.setFeatureState({ source: 'checkpoints', id: i + 1 }, { passed: false })
      }
    }
  }, [plan, track, heat, heatHours, ready])

  // Turning Follow on flies to the truck first, then keeps it centred.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !follow || !track || !plan) return
    const s = track.at(plan.hours[hourStore.get()] ?? plan.departure)
    followEaseUntil.current = performance.now() + 700
    map.easeTo({ center: s.pos, zoom: Math.max(map.getZoom(), FOLLOW_ZOOM), duration: 650 })
  }, [follow, ready, track, plan])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (map.getLayer('heat')) map.setLayoutProperty('heat', 'visibility', heatmapOn ? 'visible' : 'none')
    map.setLayoutProperty('cp', 'visibility', checkpointsOn ? 'visible' : 'none')
  }, [heatmapOn, checkpointsOn, ready, heat])

  // Light/dark: swap the basemap; 'style.load' then rebuilds our layers.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    map.setStyle(dark ? STYLES.dark : STYLES.light)
  }, [dark])

  if (failed) {
    return (
      <div className="map map-failed" role="img" aria-label="Map unavailable">
        <p>This browser cannot show the map (WebGL 2 is unavailable). The route cards and itinerary still work.</p>
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
              onFollow(false)
              if (mapRef.current) fitRoutes(mapRef.current, plan)
            }}
            title="Zoom out to the whole route" aria-label="Whole route"
          >
            <svg viewBox="0 0 20 20" aria-hidden><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" /></svg>
            <span>Whole route</span>
          </button>
          <button
            type="button"
            className={follow ? 'on' : undefined}
            aria-pressed={follow}
            onClick={() => onFollow(!follow)}
            title="Keep the truck in the middle of the map as time moves (dragging the map turns this off)" aria-label="Follow truck"
          >
            <svg viewBox="0 0 20 20" aria-hidden><circle cx="10" cy="10" r="3.2" /><path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3" /></svg>
            <span>Follow truck</span>
          </button>
          <div className="layers">
            <button type="button" aria-expanded={layersOpen} onClick={() => setLayersOpen((o) => !o)} title="Map layers and wind setting" aria-label="Layers">
              <svg viewBox="0 0 20 20" aria-hidden><path d="M10 2.5 18 7l-8 4.5L2 7z" /><path d="m2 11 8 4.5 8-4.5" /></svg>
              <span>Layers</span>
            </button>
            {layersOpen && (
              <div className="layers-pop" role="group" aria-label="Map layers">
                <label className="check">
                  <input type="checkbox" checked={heatmapOn} onChange={(e) => props.onHeatmap(e.target.checked)} />
                  Weather heatmap
                </label>
                <label className="check">
                  <input type="checkbox" checked={checkpointsOn} onChange={(e) => props.onCheckpoints(e.target.checked)} />
                  Checkpoint dots (zoomed in)
                </label>
                <div className="layers-label">Rate wind on</div>
                <div className="seg small" role="radiogroup" aria-label="Wind value used for risk">
                  <button type="button" role="radio" aria-checked={mode === 'gust'} className={mode === 'gust' ? 'on' : undefined} onClick={() => props.onMode('gust')} title="Gusts are what push trucks over (default)">
                    Gusts
                  </button>
                  <button type="button" role="radio" aria-checked={mode === 'sustained'} className={mode === 'sustained' ? 'on' : undefined} onClick={() => props.onMode('sustained')} title="Rate wind on sustained speed instead">
                    Sustained
                  </button>
                </div>
              </div>
            )}
          </div>
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
  map.fitBounds([[w, s], [e, n]], { padding: wide ? { top: 80, bottom: 190, left: 60, right: 150 } : 30, duration: 600 })
}
