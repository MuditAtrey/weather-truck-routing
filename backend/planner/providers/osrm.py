"""OSRM public demo server (car profile), used as the fallback and for long trips.

- GET only; the demo rejects POST.
- `overview=full` is required: per-segment annotations only line up with the full
  geometry, not the simplified default.
- `radiuses` stops OSRM from silently snapping a point in a lake to a road 40 km away.
- The demo often returns fewer than 3 alternatives; the router fills the gap.
"""

import httpx
from django.conf import settings

from ..domain.geo import LatLon
from ..domain.polyline import decode
from ..domain.route import Route, from_segment_durations
from .errors import RoutingError
from .http import HostGate, client

SNAP_RADIUS_M = 10_000

gate = HostGate(1.0)


def build_url(points: list[LatLon], alternatives: bool) -> str:
    coords = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in points)
    radiuses = ";".join([str(SNAP_RADIUS_M)] * len(points))
    alts = "3" if alternatives and len(points) == 2 else "false"
    return (
        f"{settings.OSRM_URL}/route/v1/driving/{coords}"
        f"?overview=full&geometries=polyline6&annotations=duration,distance"
        f"&alternatives={alts}&steps=false&generate_hints=false&radiuses={radiuses}"
    )


def _route(r: dict[str, object]) -> Route:
    coords = decode(r["geometry"], 6)  # type: ignore[arg-type]
    durations: list[float] = []
    for leg in r["legs"]:  # type: ignore[attr-defined]
        durations.extend(leg["annotation"]["duration"])
    return from_segment_durations(coords, durations, float(r["duration"]))  # type: ignore[arg-type]


def parse(data: dict[str, object]) -> list[Route]:
    routes = [_route(r) for r in data.get("routes") or []]  # type: ignore[attr-defined]
    if not routes:
        raise RoutingError("no_route", "osrm", "no routes")
    return routes


ERROR_KINDS = {"NoRoute": "no_route", "NoSegment": "not_on_road"}


async def fetch(points: list[LatLon], alternatives: bool = True) -> list[Route]:
    await gate.wait()
    try:
        resp = await client().get(build_url(points, alternatives))
    except httpx.HTTPError as exc:
        raise RoutingError("unavailable", "osrm", type(exc).__name__) from exc
    if resp.status_code >= 500 or resp.status_code == 429:
        raise RoutingError("unavailable", "osrm", f"HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise RoutingError("unavailable", "osrm", "invalid JSON") from exc
    if data.get("code") != "Ok":
        code = str(data.get("code"))
        raise RoutingError(ERROR_KINDS.get(code, "unavailable"), "osrm", code)
    return parse(data)
