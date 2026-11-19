// The map key. Folded: the five line colours and what wind value they are rated on.
// Open: every symbol exactly as the map draws it, and the rules behind the colours.
import { useState } from 'react'
import { LEVEL_COLORS, LEVELS, OTHER_ROUTE, THRESHOLDS, UNKNOWN_COLOR, type WindMode } from '../lib/risk'
import { SYMBOL_LABEL, type SymbolId } from '../lib/symbols'
import Symbol from './Symbol'

const KEY_SYMBOLS: SymbolId[] = ['start', 'end', 'via', 'break', 'rest', 'rest-unknown', 'high', 'severe', 'notravel', 'truck']

function Line({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg className="key-line" width="22" height="10" viewBox="0 0 22 10" aria-hidden>
      <path d="M2 5h18" stroke="#1f2937" strokeWidth="7" strokeLinecap="round" opacity="0.85" />
      <path d="M2 5h18" stroke={color} strokeWidth="4.5" strokeLinecap="round" />
      {dashed && <path d="M3 5h16" stroke="#fff" strokeWidth="1.5" strokeDasharray="2.5 2.5" />}
    </svg>
  )
}

export default function Legend({ mode }: { mode: WindMode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`legend${open ? ' open' : ''}`}>
      <button type="button" className="legend-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="legend-title">Key</span>
        {LEVELS.map((l, i) => (
          <span key={l} className="legend-chip">
            <Line color={LEVEL_COLORS[i]!} dashed={i === 4} />
            {l}
          </span>
        ))}
        <span className="legend-more">{open ? 'Less' : 'More'}</span>
      </button>
      {open && (
        <div className="legend-body">
          <p className="legend-rated">Rated on {mode === 'gust' ? 'gusts' : 'sustained wind'}, rain and snow at the time the truck gets there.</p>
          <ul className="key-symbols">
            {KEY_SYMBOLS.map((id) => (
              <li key={id}>
                <Symbol id={id} size={18} />
                {SYMBOL_LABEL[id]}
              </li>
            ))}
            <li>
              <Line color={OTHER_ROUTE} />
              Another route (click to pick)
            </li>
            <li>
              <Line color={UNKNOWN_COLOR} />
              No forecast (never counted as calm)
            </li>
          </ul>
          <details className="key-rules">
            <summary>Risk rules</summary>
            <table>
              <thead>
                <tr>
                  <th />
                  {LEVELS.map((l) => (
                    <th key={l}>{l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(['wind', 'rain', 'snow'] as const).map((k) => (
                  <tr key={k}>
                    <th>{k === 'wind' ? (mode === 'gust' ? 'Gusts' : 'Wind') : k[0]!.toUpperCase() + k.slice(1)}</th>
                    {THRESHOLDS[k].map((v, i) => (
                      <td key={i}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              Heavy loads go up a level: 45–54 mph with over 30,000 lb is No Travel, 35–44 mph with over 40,000 lb is
              Severe. Each place takes its worst condition.
            </p>
          </details>
        </div>
      )}
    </div>
  )
}
