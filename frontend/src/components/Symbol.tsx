import { symbolParts, SYMBOL_LABEL, type SymbolId } from '../lib/symbols'

/** The shared map symbol as inline SVG, for the timeline, itinerary, popups and key. */
export default function Symbol({ id, size = 18, title }: { id: SymbolId; size?: number; title?: string }) {
  const label = title ?? SYMBOL_LABEL[id]
  return (
    <svg className="sym" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
      <title>{label}</title>
      {symbolParts(id).map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill ?? 'none'}
          stroke={p.stroke ?? 'none'}
          strokeWidth={p.width}
          strokeDasharray={p.dash?.join(' ')}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}
