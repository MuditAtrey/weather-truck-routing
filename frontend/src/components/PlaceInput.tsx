// Accessible combobox for a US place: type-ahead from Photon, or "lat, lon" typed in.
// Enter only picks a highlighted suggestion; it never guesses between two Portlands.
import { useEffect, useId, useRef, useState } from 'react'
import { parseCoords, searchPlaces, type PlaceOption } from '../lib/geocode'

interface Props {
  label: string
  value: PlaceOption | null
  onChange: (p: PlaceOption | null) => void
  placeholder?: string
}

export default function PlaceInput({ label, value, onChange, placeholder }: Props) {
  const id = useId()
  const [text, setText] = useState(value?.label ?? '')
  const [options, setOptions] = useState<PlaceOption[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'empty'>('idle')
  const timer = useRef<number>(0)
  const ctrl = useRef<AbortController | null>(null)

  // Presets and resets set the value from outside.
  useEffect(() => {
    setText(value?.label ?? '')
  }, [value])

  const search = (q: string) => {
    window.clearTimeout(timer.current)
    ctrl.current?.abort()
    const coords = parseCoords(q)
    if (coords) {
      setOptions([coords])
      setOpen(true)
      setActive(0)
      setState('idle')
      return
    }
    if (q.trim().length < 3) {
      setOptions([])
      setState('idle')
      return
    }
    setState('loading')
    timer.current = window.setTimeout(async () => {
      const c = new AbortController()
      ctrl.current = c
      try {
        const found = await searchPlaces(q, c.signal)
        if (c.signal.aborted) return
        setOptions(found)
        setOpen(true)
        setActive(found.length ? 0 : -1)
        setState(found.length ? 'idle' : 'empty')
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setState('error')
      }
    }, 300)
  }

  const pick = (o: PlaceOption) => {
    onChange(o)
    setText(o.label)
    setOpen(false)
    setOptions([])
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || !options.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (a + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (a <= 0 ? options.length - 1 : a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const o = options[active]
      if (o) pick(o)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const listId = `${id}-list`
  return (
    <div className="field place">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (value) onChange(null)
          search(e.target.value)
        }}
        onKeyDown={onKeyDown}
        onFocus={() => options.length && setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {state === 'loading' && <span className="hint">Searching…</span>}
      {state === 'empty' && <span className="hint">No US place found. Try a city and state, or “lat, lon”.</span>}
      {state === 'error' && <span className="hint warn">Place search is unavailable. Type “lat, lon” instead.</span>}
      {open && options.length > 0 && (
        <ul className="options" id={listId} role="listbox">
          {options.map((o, i) => (
            <li
              key={`${o.label}-${i}`}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(o)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{o.label}</span>
              {o.detail && <small>{o.detail}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
