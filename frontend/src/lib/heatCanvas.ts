// A smooth weather-risk surface drawn into a canvas that MapLibre shows as an image.
//
// It interpolates the backend's per-cell severity values (0-4, whole part = risk level)
// between cell centres, so it shows real forecast values, not point density like a
// classic heatmap layer. Outside the corridor it fades out instead of ending in a hard
// box edge. Rows are placed in Web Mercator so the image lines up with the map.
//
// The expensive part (which cells and weights feed each pixel) is computed once per
// plan; each hour is then a single pass over typed arrays (~1-3 ms).
import type { FeatureCollection, Polygon } from 'geojson'
import { LEVEL_COLORS, UNKNOWN_COLOR } from './risk'

const MAX_W = 420
const UNKNOWN = 255

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const latOf = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const STOPS = LEVEL_COLORS.map(hexRgb)
const GREY = hexRgb(UNKNOWN_COLOR)

/** Colour for a severity in 0..4, with alpha that keeps Low nearly invisible. */
function shade(v: number, out: Uint8ClampedArray, o: number, coverage: number) {
  const i = Math.min(3, Math.floor(v))
  const t = Math.min(1, v - i)
  const a = STOPS[i]!
  const b = STOPS[i + 1]!
  out[o] = a[0] + (b[0] - a[0]) * t
  out[o + 1] = a[1] + (b[1] - a[1]) * t
  out[o + 2] = a[2] + (b[2] - a[2]) * t
  // Low (0-1) fades in only near the Moderate edge; Moderate and up are clearly visible.
  const alpha = v < 0.6 ? 0 : v < 1 ? ((v - 0.6) / 0.4) * 150 : 150 + Math.min(1, (v - 1) / 3) * 70
  out[o + 3] = alpha * coverage
}

export interface HeatCanvas {
  canvas: HTMLCanvasElement
  /** Corners for a MapLibre canvas source: top-left, top-right, bottom-right, bottom-left. */
  coordinates: [[number, number], [number, number], [number, number], [number, number]]
  draw: (values: Uint8Array) => void
}

export function createHeatCanvas(grid: FeatureCollection<Polygon, { cell: number }>): HeatCanvas | null {
  if (!grid.features.length) return null
  // Cells are squares on a regular lat/lon grid; recover size, rows and columns.
  const first = grid.features[0]!.geometry.coordinates[0]!
  const size = Math.abs(first[1]![0]! - first[0]![0]!)
  const index = new Map<string, number>()
  let w = 180, e = -180, s = 90, n = -90
  grid.features.forEach((f, i) => {
    const [lon, lat] = f.geometry.coordinates[0]![0] as [number, number]
    index.set(`${Math.round(lat / size)},${Math.round(lon / size)}`, i)
    w = Math.min(w, lon); e = Math.max(e, lon + size); s = Math.min(s, lat); n = Math.max(n, lat + size)
  })
  const yTop = mercY(n)
  const yBottom = mercY(s)
  const xSpan = ((e - w) * Math.PI) / 180
  const W = Math.min(MAX_W, Math.max(64, Math.round((e - w) / size) * 12))
  const H = Math.max(32, Math.round((W * (yTop - yBottom)) / xSpan))

  // For every pixel: up to 4 surrounding cell centres and their bilinear weights.
  const idx = new Int32Array(W * H * 4).fill(-1)
  const wt = new Float32Array(W * H * 4)
  for (let py = 0; py < H; py++) {
    const lat = latOf(yTop - ((py + 0.5) / H) * (yTop - yBottom))
    const fr = lat / size - 0.5
    const r0 = Math.floor(fr)
    const ty = fr - r0
    for (let px = 0; px < W; px++) {
      const lon = w + ((px + 0.5) / W) * (e - w)
      const fc = lon / size - 0.5
      const c0 = Math.floor(fc)
      const tx = fc - c0
      const base = (py * W + px) * 4
      const corners: [number, number, number][] = [
        [r0, c0, (1 - ty) * (1 - tx)],
        [r0, c0 + 1, (1 - ty) * tx],
        [r0 + 1, c0, ty * (1 - tx)],
        [r0 + 1, c0 + 1, ty * tx],
      ]
      corners.forEach(([r, c, weight], k) => {
        const cell = index.get(`${r},${c}`)
        if (cell !== undefined) {
          idx[base + k] = cell
          wt[base + k] = weight
        }
      })
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(W, H)
  const px = image.data

  const draw = (values: Uint8Array) => {
    for (let p = 0, b = 0; p < W * H; p++, b += 4) {
      let sum = 0, known = 0, unknown = 0
      for (let k = 0; k < 4; k++) {
        const cell = idx[b + k]!
        if (cell < 0) continue
        const v = values[cell]!
        const weight = wt[b + k]!
        if (v === UNKNOWN) unknown += weight
        else {
          sum += (v / 50) * weight
          known += weight
        }
      }
      const o = p * 4
      const coverage = Math.min(1, (known + unknown) * 1.6) // soft corridor edge
      if (known > 0) shade(sum / known, px, o, coverage * (known / (known + unknown)))
      else if (unknown > 0) {
        px[o] = GREY[0]; px[o + 1] = GREY[1]; px[o + 2] = GREY[2]
        px[o + 3] = 70 * coverage
      } else px[o + 3] = 0
    }
    ctx.putImageData(image, 0, 0)
  }

  return { canvas, coordinates: [[w, n], [e, n], [e, s], [w, s]], draw }
}

/** Decode the API's base64 bytes (one per cell) for each hour. */
export function decodeHours(hours: string[]): Uint8Array[] {
  return hours.map((h) => Uint8Array.from(atob(h), (c) => c.charCodeAt(0)))
}
