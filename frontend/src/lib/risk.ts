// Risk levels, labels and colours shared by the map, legend and route cards.
// Palette: ColorBrewer YlOrRd steps (colour-blind safe), with Low kept neutral so
// that only real risk draws the eye. No Travel also gets a non-colour cue (ring).
export const LEVELS = ['Low', 'Moderate', 'High', 'Severe', 'No Travel'] as const
export const LEVEL_COLORS = ['#94a3b8', '#fdb84d', '#f4732a', '#d7191c', '#5c0517'] as const
export const UNKNOWN_COLOR = '#c4c9d1'

export const THRESHOLDS = {
  wind: ['< 25 mph', '25–34', '35–44', '45–54', '≥ 55 mph'],
  rain: ['< 0.10 in/hr', '0.10–0.25', '0.25–0.50', '0.50–1.00', '> 1.00'],
  snow: ['< 0.5 in/hr', '0.5–1.0', '1.0–2.0', '2.0–3.0', '> 3.0'],
} as const

/** Parse one character of the API's level strings: '0'..'4' or 'u' (unknown). */
export function levelAt(levels: string, i: number): number | null {
  const c = levels.charCodeAt(i) - 48
  return c >= 0 && c <= 4 ? c : null
}

export const DRIVERS: Record<string, string> = { w: 'wind', r: 'rain', s: 'snow' }

export type WindMode = 'sustained' | 'gust'
