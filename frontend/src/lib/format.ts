const fmtCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string, withDay: boolean) {
  const key = `${timeZone}|${withDay}`
  let f = fmtCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: withDay ? 'short' : undefined,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    })
    fmtCache.set(key, f)
  }
  return f
}

/** "Thu 2:20 PM CST" in the given IANA zone. */
export function clock(epochS: number, timeZone: string, withDay = true): string {
  return formatter(timeZone, withDay).format(new Date(epochS * 1000))
}

export function duration(seconds: number): string {
  const m = Math.round(seconds / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d} d ${h % 24} h`
  return h > 0 ? `${h} h ${String(m % 60).padStart(2, '0')} m` : `${m} min`
}

export const miles = (mi: number) => `${Math.round(mi).toLocaleString('en-US')} mi`

export function num(v: number | null | undefined, digits: number, unit: string): string {
  return v === null || v === undefined ? '—' : `${v.toFixed(digits)} ${unit}`
}

/** Current wall-clock time in a zone, shaped for <input type="datetime-local">. */
export function localInputValue(timeZone: string, offsetMinutes = 0): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  )
  const minute = String(Math.floor(Number(parts.minute) / 15) * 15).padStart(2, '0')
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${minute}`
}

export function zoneAbbrev(timeZone: string): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value ?? timeZone
  )
}
