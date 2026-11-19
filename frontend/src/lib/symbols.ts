// One symbol set, used identically on the map, timeline, itinerary, popups and key.
//
// Each symbol is a list of vector parts in a 24x24 box. React renders them as SVG; the
// map draws the same parts on a canvas with Path2D (synchronous, so nothing races the
// map's style loading). Shapes follow US road-sign conventions truckers already read:
// blue rounded squares for services (rest stops), a diamond for warnings, an octagon
// only for No Travel.
import { LEVEL_COLORS } from './risk'

export type SymbolId = 'start' | 'end' | 'break' | 'rest' | 'break-unknown' | 'rest-unknown' | 'high' | 'severe' | 'notravel' | 'truck'

interface Part {
  d: string
  fill?: string
  stroke?: string
  width?: number
  dash?: number[]
}

const INK = '#111827'
const NAVY = '#1e3a8a'
const SLATE = '#64748b'
const WHITE = '#ffffff'

const roundSquare = 'M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z'
const cup = [
  { d: 'M6.5 9h9v4.5a3.5 3.5 0 0 1-3.5 3.5h-2a3.5 3.5 0 0 1-3.5-3.5z', fill: WHITE },
  { d: 'M15.5 10h1.2a2 2 0 0 1 0 4h-1.2', stroke: WHITE, width: 1.6 },
]
const bed = [
  { d: 'M5 17V8M5 14h14v3', stroke: WHITE, width: 2 },
  { d: 'M7 10.5h4v2.5H7z', fill: WHITE },
  { d: 'M12 11h5.5a1.5 1.5 0 0 1 1.5 1.5V14H12z', fill: WHITE },
]

const PARTS: Record<SymbolId, Part[]> = {
  start: [{ d: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16z', fill: WHITE, stroke: INK, width: 3.5 }],
  end: [
    { d: 'M12 1.5a10.5 10.5 0 1 1 0 21 10.5 10.5 0 0 1 0-21z', fill: INK, stroke: WHITE, width: 2 },
    { d: 'M9 6.5v11', stroke: WHITE, width: 1.8 },
    { d: 'M9.6 6.5h7l-2 3 2 3h-7z', fill: WHITE },
  ],
  break: [{ d: roundSquare, fill: NAVY, stroke: WHITE, width: 2 }, ...cup],
  rest: [{ d: roundSquare, fill: NAVY, stroke: WHITE, width: 2 }, ...bed],
  'break-unknown': [{ d: roundSquare, fill: SLATE, stroke: WHITE, width: 2, dash: [3, 2] }, ...cup],
  'rest-unknown': [{ d: roundSquare, fill: SLATE, stroke: WHITE, width: 2, dash: [3, 2] }, ...bed],
  high: [
    { d: 'M12 1.5 22.5 12 12 22.5 1.5 12z', fill: LEVEL_COLORS[2], stroke: WHITE, width: 2 },
    { d: 'M12 7v6.5', stroke: INK, width: 2.4 },
    { d: 'M12 15.4a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z', fill: INK },
  ],
  severe: [
    { d: 'M12 1.5 22.5 12 12 22.5 1.5 12z', fill: LEVEL_COLORS[3], stroke: WHITE, width: 2 },
    { d: 'M12 7v6.5', stroke: WHITE, width: 2.4 },
    { d: 'M12 15.4a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z', fill: WHITE },
  ],
  notravel: [
    { d: 'M8 1.5h8l6.5 6.5v8L16 22.5H8L1.5 16V8z', fill: LEVEL_COLORS[4], stroke: WHITE, width: 2 },
    { d: 'M6.5 12h11', stroke: WHITE, width: 3 },
  ],
  truck: [
    { d: 'M12 1a11 11 0 1 1 0 22 11 11 0 0 1 0-22z', fill: WHITE, stroke: INK, width: 1.8 },
    { d: 'M9 10h6v10H9z', fill: '#f1f5f9', stroke: INK, width: 1.3 }, // trailer
    { d: 'M9.3 4.2h5.4a1 1 0 0 1 1 1V9H8.3V5.2a1 1 0 0 1 1-1z', fill: NAVY }, // cab, facing up
    { d: 'M9.6 5.2h4.8v1.5H9.6z', fill: '#bfdbfe' }, // windscreen
  ],
}

export function symbolParts(id: SymbolId): Part[] {
  return PARTS[id]
}

/** Draw a symbol into ImageData for map.addImage (size in CSS px; drawn at 2x). */
export function symbolImage(id: SymbolId, size: number): ImageData {
  const px = Math.round(size * 2)
  const c = document.createElement('canvas')
  c.width = px
  c.height = px
  const g = c.getContext('2d')!
  g.scale(px / 24, px / 24)
  g.lineCap = 'round'
  g.lineJoin = 'round'
  if (id !== 'truck') {
    g.shadowColor = 'rgba(0,0,0,0.25)'
    g.shadowBlur = 1.5
  }
  for (const p of PARTS[id]) {
    const path = new Path2D(p.d)
    if (p.fill) {
      g.fillStyle = p.fill
      g.fill(path)
    }
    if (p.stroke) {
      g.shadowBlur = 0
      g.setLineDash(p.dash ?? [])
      g.strokeStyle = p.stroke
      g.lineWidth = p.width ?? 1.5
      g.stroke(path)
    }
  }
  return g.getImageData(0, 0, px, px)
}

export const MAP_SIZES: Record<SymbolId, number> = {
  start: 18,
  end: 24,
  break: 22,
  rest: 26,
  'break-unknown': 22,
  'rest-unknown': 26,
  high: 22,
  severe: 22,
  notravel: 24,
  truck: 34,
}

export const SYMBOL_LABEL: Record<SymbolId, string> = {
  start: 'Start',
  end: 'Destination',
  break: '30-minute break',
  rest: '10-hour rest',
  'break-unknown': '30-minute break, no known truck parking',
  'rest-unknown': '10-hour rest, no known truck parking',
  high: 'High risk stretch',
  severe: 'Severe risk stretch',
  notravel: 'No Travel stretch',
  truck: 'Truck at the selected time',
}

export function stopSymbol(kind: 'break' | 'rest', known: boolean): SymbolId {
  return known ? kind : (`${kind}-unknown` as SymbolId)
}

export function hazardSymbol(level: number): SymbolId | null {
  return level >= 4 ? 'notravel' : level === 3 ? 'severe' : level === 2 ? 'high' : null
}

/** The same symbol as an SVG string, for map popups (which take HTML). */
export function symbolSvg(id: SymbolId, size = 16): string {
  const parts = PARTS[id]
    .map(
      (p) =>
        `<path d="${p.d}" fill="${p.fill ?? 'none'}" stroke="${p.stroke ?? 'none'}"` +
        (p.width ? ` stroke-width="${p.width}"` : '') +
        (p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : '') +
        ' stroke-linecap="round" stroke-linejoin="round"/>',
    )
    .join('')
  return `<svg class="sym" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${parts}</svg>`
}

export const ALL_SYMBOLS = Object.keys(PARTS) as SymbolId[]
