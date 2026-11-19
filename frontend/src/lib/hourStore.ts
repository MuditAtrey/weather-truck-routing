// The playhead lives outside React state: the slider and playback write it and the map
// subscribes imperatively, so playing never re-renders the React tree or the map.
//
// It is a fractional hour index into plan.hours (2.5 = halfway between hours 2 and 3),
// so the truck moves continuously while the heatmap shows the nearest forecast hour.
import { useSyncExternalStore } from 'react'

type Listener = () => void
let hour = 0
const listeners = new Set<Listener>()

export const hourStore = {
  get: () => hour,
  set: (h: number) => {
    if (h !== hour) {
      hour = h
      listeners.forEach((l) => l())
    }
  },
  subscribe: (l: Listener) => {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
}

/** The playhead rounded down to 5 minutes; components re-render that often, not per frame. */
export const usePlayhead = () => useSyncExternalStore(hourStore.subscribe, () => Math.floor(hour * 12 + 1e-9) / 12)

/** Clock time at a fractional hour index. */
export function timeAt(hours: number[], h: number): number {
  const i = Math.max(0, Math.min(hours.length - 1, Math.floor(h)))
  const a = hours[i] ?? 0
  const b = hours[i + 1] ?? a + 3600
  return a + (b - a) * (h - i)
}
