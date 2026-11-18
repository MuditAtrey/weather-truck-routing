// The heatmap hour lives outside React state: the slider writes it and the map
// subscribes imperatively, so dragging never re-renders the React tree or the map.
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

export const useHour = () => useSyncExternalStore(hourStore.subscribe, hourStore.get)
