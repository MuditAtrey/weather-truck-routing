// Place search with Photon (komoot), which allows type-ahead use, unlike Nominatim.
// Requests are debounced by the caller, cancelled when stale, and cached.
export interface PlaceOption {
  label: string
  detail: string
  lat: number
  lon: number
}

const cache = new Map<string, PlaceOption[]>()
const LAYERS = ['city', 'locality', 'district', 'street', 'house']

interface PhotonFeature {
  geometry: { coordinates: [number, number] }
  properties: {
    name?: string
    housenumber?: string
    street?: string
    city?: string
    county?: string
    state?: string
    postcode?: string
    type?: string
  }
}

export const STATE_ABBR: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO',
  Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID',
  Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR',
  Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD',
  Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC',
  'Puerto Rico': 'PR',
}

function toOption(f: PhotonFeature): PlaceOption {
  const p = f.properties
  const state = p.state ? (STATE_ABBR[p.state] ?? p.state) : ''
  const street = p.street ? `${p.housenumber ? `${p.housenumber} ` : ''}${p.street}` : ''
  const name = p.type === 'house' || p.type === 'street' ? street || p.name || '' : p.name || street
  const place = [p.type === 'city' ? '' : p.city, state].filter(Boolean).join(', ')
  const [lon, lat] = f.geometry.coordinates
  return { label: [name, place].filter(Boolean).join(', '), detail: p.county ?? '', lat, lon }
}

/** "39.74, -104.99" typed directly into the box. */
export function parseCoords(q: string): PlaceOption | null {
  const m = q.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/)
  if (!m) return null
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, detail: 'Coordinates', lat, lon }
}

export async function searchPlaces(q: string, signal: AbortSignal): Promise<PlaceOption[]> {
  const key = q.trim().toLowerCase()
  const hit = cache.get(key)
  if (hit) return hit
  const params = new URLSearchParams({ q: key, limit: '6', lang: 'en', countrycode: 'US' })
  LAYERS.forEach((l) => params.append('layer', l))
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal })
  if (!res.ok) throw new Error(`Place search failed (${res.status})`)
  const data = (await res.json()) as { features: PhotonFeature[] }
  const seen = new Set<string>()
  const options = data.features.map(toOption).filter((o) => {
    if (!o.label || seen.has(o.label)) return false
    seen.add(o.label)
    return true
  })
  cache.set(key, options)
  return options
}
