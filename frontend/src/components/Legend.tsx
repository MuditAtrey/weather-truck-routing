import { useState } from 'react'
import { LEVEL_COLORS, LEVELS, THRESHOLDS, UNKNOWN_COLOR } from '../lib/risk'

export default function Legend() {
  const [open, setOpen] = useState(false)
  return (
    <div className={`legend${open ? ' open' : ''}`}>
      <button type="button" className="legend-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {LEVELS.map((l, i) => (
          <span key={l} className="legend-chip">
            <i style={{ background: LEVEL_COLORS[i] }} />
            {l}
          </span>
        ))}
        <span className="legend-more">{open ? 'Hide rules' : 'Rules'}</span>
      </button>
      {open && (
        <div className="legend-body">
          <table>
            <thead>
              <tr>
                <th />
                {LEVELS.map((l, i) => (
                  <th key={l}>
                    <i style={{ background: LEVEL_COLORS[i] }} />
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(['wind', 'rain', 'snow'] as const).map((k) => (
                <tr key={k}>
                  <th>{k[0]!.toUpperCase() + k.slice(1)}</th>
                  {THRESHOLDS[k].map((v, i) => (
                    <td key={i}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Load rules: 45–54 mph with more than 30,000 lb cargo is No Travel; 35–44 mph with more than 40,000 lb
            is Severe. A point’s risk is its worst condition.
          </p>
          <p>
            <i className="swatch" style={{ background: UNKNOWN_COLOR }} /> Grey means no forecast for that place and
            time. It is never counted as calm.
          </p>
        </div>
      )}
    </div>
  )
}
