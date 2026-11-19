"""Server-side Open-Meteo download, used only as a fallback.

Normally the browser downloads forecasts with its own per-IP quota. When that quota is
used up (a busy office network, or someone re-planning a coast-to-coast trip many times),
Django fetches the missing points from its own address instead.
"""

import time
from collections.abc import Sequence
from dataclasses import dataclass

import httpx

from ..domain.forecast import HOUR
from ..domain.geo import LatLon
from .http import client

URL = "https://api.open-meteo.com/v1/forecast"
MAX_PER_REQUEST = 1000
VARS = ("wind_speed_10m", "wind_gusts_10m", "rain", "showers", "snowfall")


@dataclass(frozen=True, slots=True)
class Hourly:
    start: int
    values: dict[str, list[float | None]]


class WeatherUnavailable(Exception):
    pass


async def fetch(points: Sequence[LatLon], last_hour: int) -> list[Hourly]:
    """Hourly series from the current hour through `last_hour` for each point."""
    now_hour = int(time.time() // HOUR * HOUR)
    hours = min(384, max(1, (last_hour - now_hour) // HOUR + 2))
    out: list[Hourly] = []
    for i in range(0, len(points), MAX_PER_REQUEST):
        chunk = points[i : i + MAX_PER_REQUEST]
        data = {
            "latitude": ",".join(f"{p[0]}" for p in chunk),
            "longitude": ",".join(f"{p[1]}" for p in chunk),
            "hourly": ",".join(VARS),
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",
            "timeformat": "unixtime",
            "forecast_hours": str(hours),
        }
        try:
            resp = await client().post(URL, data=data, timeout=20.0)
        except httpx.HTTPError as exc:
            raise WeatherUnavailable(type(exc).__name__) from exc
        if resp.status_code != 200:
            raise WeatherUnavailable(f"HTTP {resp.status_code}")
        body = resp.json()
        locations = body if isinstance(body, list) else [body]
        if len(locations) != len(chunk):
            raise WeatherUnavailable("wrong number of locations")
        for loc in locations:
            h = loc["hourly"]
            out.append(Hourly(start=int(h["time"][0]), values={v: h[v] for v in VARS}))
    return out


def window(h: Hourly, start: int, end: int) -> dict[str, list[float | None]]:
    """The hours start..end (inclusive) of a series, None where it has no data."""
    first = (start - h.start) // HOUR
    n = (end - start) // HOUR + 1
    keys = {"wind": "wind_speed_10m", "gust": "wind_gusts_10m", "rain": "rain"}
    keys |= {"showers": "showers", "snow": "snowfall"}
    out: dict[str, list[float | None]] = {}
    for name, var in keys.items():
        arr = h.values[var]
        out[name] = [arr[first + k] if 0 <= first + k < len(arr) else None for k in range(n)]
    return out
