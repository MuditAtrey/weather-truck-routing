// Phone layout: the map fills the screen and the results sit in a bottom sheet that
// snaps between three heights, the pattern Google and Apple Maps use. The map stays
// usable at every height, and the trip clock stays in the always-visible top part.
//
// Height (not a transform) is animated so the scrolling body always ends at the screen
// edge; only the sheet re-lays out, the map underneath does not.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type Detent = 'peek' | 'half' | 'full'

interface Props {
  head: ReactNode
  children: ReactNode
  detent: Detent
  onDetent: (d: Detent) => void
  /** Reports the settled height so the map can keep its centre above the sheet. */
  onHeight: (px: number) => void
  top: number // space kept above the sheet at full height (the app header)
}

export default function Sheet({ head, children, detent, onDetent, onHeight, top }: Props) {
  const headRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const [vh, setVh] = useState(() => window.innerHeight)
  const [headH, setHeadH] = useState(150)
  const [drag, setDrag] = useState<number | null>(null)
  const start = useRef({ y: 0, h: 0, lastY: 0, lastT: 0, v: 0, moved: false })

  useEffect(() => {
    const on = () => setVh(window.innerHeight)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  useLayoutEffect(() => {
    const el = headRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeadH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const heights: Record<Detent, number> = {
    peek: Math.min(vh * 0.45, headH + 76), // the clock plus the selected route's name
    half: Math.round(vh * 0.52),
    full: vh - top,
  }
  const settled = heights[detent]
  const height = drag ?? settled

  useEffect(() => {
    onHeight(settled)
  }, [settled])

  const snap = useCallback(
    (h: number, velocity: number) => {
      const aim = h + velocity * 180 // fling (velocity: px/ms, up is positive): carry on in the direction of travel
      const order: Detent[] = ['peek', 'half', 'full']
      let best: Detent = 'peek'
      for (const d of order) if (Math.abs(heights[d] - aim) < Math.abs(heights[best] - aim)) best = d
      onDetent(best)
    },
    [heights.peek, heights.half, heights.full, onDetent],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const now = performance.now()
    start.current = { y: e.clientY, h: settled, lastY: e.clientY, lastT: now, v: 0, moved: false }
    setDrag(settled)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag === null) return
    const s = start.current
    if (Math.abs(e.clientY - s.y) > 4) s.moved = true
    const now = performance.now()
    s.v = (e.clientY - s.lastY) / Math.max(1, now - s.lastT) // px per ms, down is positive
    s.lastY = e.clientY
    s.lastT = now
    setDrag(Math.max(heights.peek * 0.8, Math.min(heights.full, s.h - (e.clientY - s.y))))
  }
  const onPointerUp = () => {
    if (drag === null) return
    const s = start.current
    setDrag(null)
    if (!s.moved) {
      // A tap on the handle steps through the heights.
      onDetent(detent === 'peek' ? 'half' : detent === 'half' ? 'full' : 'peek')
      return
    }
    snap(drag, -s.v)
  }

  return (
    <aside
      ref={sheetRef}
      className={`panel sheet${drag !== null ? ' dragging' : ''}`}
      style={{ height }}
      aria-label="Trip results"
    >
      <div ref={headRef} className="sheet-head">
        <div
          className="grabber"
          role="button"
          tabIndex={0}
          aria-label={detent === 'full' ? 'Collapse results' : 'Expand results'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onDetent(detent === 'full' ? 'peek' : detent === 'peek' ? 'half' : 'full')
            }
          }}
        >
          <span />
        </div>
        {head}
      </div>
      <div className="sheet-body">{children}</div>
    </aside>
  )
}
