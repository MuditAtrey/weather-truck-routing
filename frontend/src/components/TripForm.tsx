import { useEffect, useState } from 'react'
import { api, type PlanIn } from '../api/client'
import { localInputValue, zoneAbbrev } from '../lib/format'
import type { PlaceOption } from '../lib/geocode'
import PlaceInput from './PlaceInput'

export interface Preset {
  name: string
  hint: string
  origin: PlaceOption
  destination: PlaceOption
  cargo: number
}

// Picked to show different behaviour; all under Valhalla's distance cap except the last.
export const PRESETS: Preset[] = [
  {
    name: 'Dallas → Denver',
    hint: '3 truck routes',
    origin: { label: 'Dallas, TX', detail: '', lat: 32.7767, lon: -96.797 },
    destination: { label: 'Denver, CO', detail: '', lat: 39.7392, lon: -104.9903 },
    cargo: 30000,
  },
  {
    name: 'Denver → Salt Lake City',
    hint: 'Wyoming wind corridor',
    origin: { label: 'Denver, CO', detail: '', lat: 39.7392, lon: -104.9903 },
    destination: { label: 'Salt Lake City, UT', detail: '', lat: 40.7608, lon: -111.891 },
    cargo: 42000,
  },
  {
    name: 'Sacramento → Reno',
    hint: 'Sierra passes',
    origin: { label: 'Sacramento, CA', detail: '', lat: 38.5816, lon: -121.4944 },
    destination: { label: 'Reno, NV', detail: '', lat: 39.5296, lon: -119.8138 },
    cargo: 35000,
  },
  {
    name: 'Chicago → San Francisco',
    hint: 'long haul, fallback router',
    origin: { label: 'Chicago, IL', detail: '', lat: 41.8781, lon: -87.6298 },
    destination: { label: 'San Francisco, CA', detail: '', lat: 37.7749, lon: -122.4194 },
    cargo: 38000,
  },
]

const zones = new Map<string, Promise<string>>()

/** Origin time zone, looked up once per place. */
function zoneFor(p: PlaceOption): Promise<string> {
  const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`
  let z = zones.get(key)
  if (!z) {
    z = api.timezone(p.lat, p.lon).then((r) => r.timezone)
    z.catch(() => zones.delete(key))
    zones.set(key, z)
  }
  return z
}

interface Props {
  busy: boolean
  onSubmit: (req: PlanIn, labels: [string, string]) => void
  onCancel: () => void
  /** Called with the request the form would send, so the app can start planning early. */
  onPrefetch?: (req: PlanIn) => void
  /** On phones, hide the form behind "Edit trip" while results are showing. */
  folded?: boolean
}

export default function TripForm({ busy, onSubmit, onCancel, onPrefetch, folded }: Props) {
  const [origin, setOrigin] = useState<PlaceOption | null>(null)
  const [destination, setDestination] = useState<PlaceOption | null>(null)
  // Stops to drive through, in order (like Google Maps' "Add stop"). Empty rows are ignored.
  const [via, setVia] = useState<{ key: number; place: PlaceOption | null }[]>([])
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [departure, setDeparture] = useState(() => localInputValue(tz, 30))
  const [departureTouched, setDepartureTouched] = useState(false)
  const [cargo, setCargo] = useState('30000')
  const [interval, setIntervalMi] = useState<10 | 25 | 50>(25)
  const [hos, setHos] = useState(true)
  const [error, setError] = useState('')

  // Departure is entered in the origin's local time; look the zone up when it changes.
  useEffect(() => {
    if (!origin) return
    let current = true
    zoneFor(origin)
      .then((zone) => {
        if (!current) return
        setTz(zone)
        if (!departureTouched) setDeparture(localInputValue(zone, 30))
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [origin, departureTouched])

  const cargoNum = Number(cargo)
  const cargoValid = cargo.trim() !== '' && Number.isInteger(cargoNum) && cargoNum >= 0 && cargoNum <= 80000

  /** The request the form would send right now (departure resolved in the origin's zone). */
  const buildRequest = async (): Promise<PlanIn | null> => {
    if (!origin || !destination || !cargoValid) return null
    // An untouched departure means "leave soon": compute it now, in the origin's zone, so
    // a slow zone lookup or a page left open for an hour can't send a stale or wrong time.
    let dep = departure
    if (!departureTouched) {
      const zone = await zoneFor(origin).catch(() => tz)
      dep = localInputValue(zone, 30)
      setTz(zone)
      setDeparture(dep)
    }
    return {
      origin: { lat: origin.lat, lon: origin.lon, label: origin.label },
      destination: { lat: destination.lat, lon: destination.lon, label: destination.label },
      via: via.flatMap(({ place: v }) => (v ? [{ lat: v.lat, lon: v.lon, label: v.label }] : [])),
      departure_local: dep,
      cargo_lb: cargoNum,
      interval_mi: interval,
      hos,
    }
  }

  // Start planning in the background once the trip is fully described; the truck legs of
  // a long trip take 15-30 s, most of which then passes while the user checks the form.
  useEffect(() => {
    if (!onPrefetch || busy || !origin || !destination || !cargoValid) return
    let current = true
    const t = window.setTimeout(async () => {
      const req = await buildRequest()
      if (current && req) onPrefetch(req)
    }, 600)
    return () => {
      current = false
      window.clearTimeout(t)
    }
    // buildRequest reads exactly the state listed here.
  }, [origin, destination, via, cargo, interval, hos, departure, departureTouched, busy])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!origin || !destination) return setError('Pick an origin and a destination from the suggestions.')
    if (!cargoValid) return setError('Cargo weight must be a whole number from 0 to 80,000 lb.')
    setError('')
    const req = await buildRequest()
    if (req) onSubmit(req, [origin.label, destination.label])
  }

  const usePreset = (p: Preset) => {
    setOrigin(p.origin)
    setDestination(p.destination)
    setVia([])
    setCargo(String(p.cargo))
    setDepartureTouched(false)
  }

  return (
    <form className={`trip${folded ? ' folded' : ''}`} onSubmit={submit} noValidate>
      <PlaceInput label="Origin" value={origin} onChange={setOrigin} placeholder="City, address, or lat, lon" />
      {via.map(({ key, place: v }, i) => (
        <div className="via-row" key={key}>
          <PlaceInput
            label={`Stop ${i + 1}`}
            value={v}
            onChange={(p) => setVia((list) => list.map((x) => (x.key === key ? { key, place: p } : x)))}
            placeholder="City or address to drive through"
          />
          <button
            type="button"
            className="ghost via-remove"
            aria-label={`Remove stop ${i + 1}`}
            title="Remove this stop"
            onClick={() => setVia((list) => list.filter((x) => x.key !== key))}
          >
            ×
          </button>
        </div>
      ))}
      <PlaceInput label="Destination" value={destination} onChange={setDestination} placeholder="City, address, or lat, lon" />
      {via.length < 3 && (
        <button type="button" className="link-btn add-stop" onClick={() => setVia((list) => [...list, { key: Date.now(), place: null }])}>
          + Add a stop on the way
        </button>
      )}
      <div className="row when">
        <div className="field dep">
          <label htmlFor="dep">
            Departure <span className="muted">· origin time ({zoneAbbrev(tz)})</span>
          </label>
          <input
            id="dep"
            type="datetime-local"
            value={departure}
            step={900}
            onChange={(e) => {
              setDeparture(e.target.value)
              setDepartureTouched(true)
            }}
            required
          />
        </div>
        <div className="field narrow">
          <label htmlFor="cargo">Cargo weight</label>
          <div className="suffix">
            <input
              id="cargo"
              type="number"
              inputMode="numeric"
              min={0}
              max={80000}
              step={1000}
              value={cargo}
              aria-invalid={!cargoValid}
              onChange={(e) => setCargo(e.target.value)}
            />
            <span>lb</span>
          </div>
        </div>
      </div>
      <details className="more-options">
        <summary>
          More options <span className="muted">· weather every {interval} mi, rest stops {hos ? 'on' : 'off'}</span>
        </summary>
        <div className="row">
          <fieldset className="field seg">
            <legend>Check weather every</legend>
            {([10, 25, 50] as const).map((v) => (
              <label key={v} className={interval === v ? 'on' : undefined}>
                <input type="radio" name="interval" checked={interval === v} onChange={() => setIntervalMi(v)} />
                {v} mi
              </label>
            ))}
          </fieldset>
          <label className="check" title="Adds the 30-minute break after 8 hours and 10-hour rest after 11 hours of driving">
            <input type="checkbox" checked={hos} onChange={(e) => setHos(e.target.checked)} />
            Driver rest stops (HOS)
          </label>
        </div>
      </details>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Planning…' : 'Plan routes'}
        </button>
        {busy && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <div className="presets">
        <span className="muted">Try:</span>
        {PRESETS.map((p) => (
          <button key={p.name} type="button" className="chip" onClick={() => usePreset(p)} title={p.hint} disabled={busy}>
            {p.name}
          </button>
        ))}
      </div>
    </form>
  )
}
