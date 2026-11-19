"""FOSSGIS public Valhalla server, truck profile.

Facts this module relies on (tested against the live server, Nov 2026):
- `alternates: 2` returns up to 3 routes: `trip` plus `alternates[].trip`.
- Shapes are polyline6 in (lat, lon) order.
- Truck weight is in metric tonnes; out-of-range values are silently clamped with a
  warning (code 500), which we treat as an error.
- `top_speed` is km/h. 105 km/h (65 mph) gives realistic truck times.
- Error 154: over the server's 1,500 km straight-line limit. 170/171/442: no road path.
"""

import httpx
from django.conf import settings

from ..domain.geo import LatLon
from ..domain.polyline import decode
from ..domain.route import Route, from_maneuvers
from .errors import RoutingError
from .http import HostGate, client

LB_PER_TONNE = 2204.62262
TRUCK_TARE_LB = 34_000  # typical tractor + empty 53 ft dry van
TRUCK_TOP_SPEED_KMH = 105
MAX_STRAIGHT_LINE_KM = 1450  # server limit is 1,500 km; keep a margin

gate = HostGate(1.0)


def gross_tonnes(cargo_lb: int) -> float:
    return round((cargo_lb + TRUCK_TARE_LB) / LB_PER_TONNE, 3)


def build_request(
    points: list[LatLon],
    cargo_lb: int,
    alternates: int,
    headings: list[float | None] | None = None,
) -> dict[str, object]:
    locations: list[dict[str, object]] = []
    for i, (lat, lon) in enumerate(points):
        loc: dict[str, object] = {
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "type": "break" if i in (0, len(points) - 1) else "through",
        }
        heading = headings[i] if headings else None
        if heading is not None:
            # Arrive and leave in the direction of travel, so legs join without U-turns.
            loc["heading"] = round(heading)
            loc["heading_tolerance"] = 45
            # A join point must sit on the highway itself, not a ramp or frontage road
            # beside it, or the truck exits and loops back to reach it.
            loc["search_filter"] = {"min_road_class": "primary", "exclude_ramp": True}
        locations.append(loc)
    return {
        "locations": locations,
        "costing": "truck",
        "costing_options": {
            "truck": {
                "weight": gross_tonnes(cargo_lb),
                "top_speed": TRUCK_TOP_SPEED_KMH,
            }
        },
        "alternates": alternates,
        "units": "miles",
        "directions_type": "maneuvers",
    }


def _trip_to_route(trip: dict[str, object]) -> Route:
    legs = trip["legs"]
    coords: list[LatLon] = []
    maneuvers: list[tuple[int, int, float]] = []
    for leg in legs:  # type: ignore[attr-defined]
        offset = max(0, len(coords) - 1)
        shape = decode(leg["shape"], 6)
        coords.extend(shape if not coords else shape[1:])
        for m in leg["maneuvers"]:
            maneuvers.append(
                (m["begin_shape_index"] + offset, m["end_shape_index"] + offset, float(m["time"]))
            )
    return from_maneuvers(coords, maneuvers, source="valhalla")


def parse(data: dict[str, object]) -> list[Route]:
    warnings = list(data.get("warnings") or [])  # type: ignore[call-overload]
    trip = data["trip"]
    warnings += list(trip.get("warnings") or [])  # type: ignore[attr-defined]
    for w in warnings:
        if w.get("code") == 500 and "clamped" in str(w.get("text", "")):
            raise RoutingError("bad_input", "valhalla", str(w.get("text")))
    routes = [_trip_to_route(trip)]  # type: ignore[arg-type]
    for alt in data.get("alternates") or []:  # type: ignore[attr-defined]
        routes.append(_trip_to_route(alt["trip"]))
    relaxed = [w for w in warnings if w.get("code") == 401]
    if relaxed:
        for r in routes:
            r.warnings.append("truck_restrictions_relaxed")
    return routes


ERROR_KINDS = {154: "too_far", 170: "no_route", 171: "not_on_road", 442: "no_route"}


async def fetch(
    points: list[LatLon],
    cargo_lb: int,
    alternates: int = 2,
    headings: list[float | None] | None = None,
) -> list[Route]:
    await gate.wait()
    try:
        resp = await client().post(
            f"{settings.VALHALLA_URL}/route",
            json=build_request(points, cargo_lb, alternates, headings),
        )
    except httpx.HTTPError as exc:
        raise RoutingError("unavailable", "valhalla", type(exc).__name__) from exc
    if resp.status_code >= 500:
        raise RoutingError("unavailable", "valhalla", f"HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise RoutingError("unavailable", "valhalla", "invalid JSON") from exc
    if resp.status_code != 200 or "trip" not in data:
        code = data.get("error_code")
        raise RoutingError(ERROR_KINDS.get(code, "unavailable"), "valhalla", f"error {code}")
    return parse(data)
