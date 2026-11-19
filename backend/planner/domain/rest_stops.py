"""Placing hours-of-service stops where a truck can actually stop.

Rules (49 CFR 395.3, as amended in 2020):
- A 30-minute break is due before 8 hours of driving. Any 30 minutes not driving
  counts, fueling included, so taking it earlier costs nothing.
- A 10-hour rest is due before 11 hours of driving since the last rest. It must be
  off duty, where a truck may legally park (not a highway shoulder). Resting early
  gives up the unused driving hours for that day.

So each stop goes to the latest suitable site *before* its limit, never after:
- break: the latest truck stop 3-8 hours into the shift (it can double as a fuel
  stop), else the latest public rest area or truck parking in that window;
- rest: the latest truck stop or large rest area 9-11 hours in (and within 8 hours of
  the break), else the latest legal truck parking of any size 9-11 hours in, else the
  latest from 8 hours on, up to 2 miles off the route.
If nothing qualifies, the stop stays where the clock runs out and is flagged, so the
driver knows to plan parking there. Each snap moves every later stop, so the schedule
is built one shift at a time.

Sites come from data/truck_stops.json: U.S. DOT BTS NTAD "Truck Stop Parking" (public
sites with space counts, 2019) plus OpenStreetMap truck stops and truck parking.
"""

import functools
import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from .geo import LatLon, haversine_mi
from .route import Route

H = 3600.0
BREAK_S = 0.5 * H
REST_S = 10 * H
BREAK_DUE_S = 8 * H
SHIFT_DRIVE_S = 11 * H
BREAK_EARLIEST_S = 3 * H
REST_EARLIEST_S = 9 * H
REST_FALLBACK_EARLIEST_S = 8 * H
NEAR_MI = 1.0  # a site counts as "on the route" within this distance
FAR_MI = 2.0  # accepted for the 10-hour rest when nothing closer exists
DATA = Path(__file__).resolve().parent.parent / "data" / "truck_stops.json"
NOT_FOR_OVERNIGHT = re.compile(r"weigh|scale|turnout|pull[- ]?off|chain|inspection", re.I)
CELL = 0.1  # degrees, for the site index


@dataclass(frozen=True, slots=True)
class Site:
    lat: float
    lon: float
    kind: str  # "truck_stop" | "public" | "truck_parking"
    name: str | None
    brand: str | None
    road: str | None
    spaces: int | None
    source: str  # "osm" | "ntad"

    @property
    def tier(self) -> int:
        """0 = full truck stop or big lot, 1 = sizeable public area, 2 = other, 3 = small."""
        if self.kind == "truck_stop" or (self.spaces or 0) >= 50:
            return 0
        if self.kind == "public" and (self.spaces or 0) >= 20:
            return 1
        if self.kind == "public":
            return 2
        return 3

    @property
    def overnight_ok(self) -> bool:
        return not NOT_FOR_OVERNIGHT.search(self.name or "")


@functools.cache
def _index() -> dict[tuple[int, int], list[Site]]:
    grid: dict[tuple[int, int], list[Site]] = defaultdict(list)
    for r in json.loads(DATA.read_text()):
        site = Site(
            lat=r["lat"],
            lon=r["lon"],
            kind=r["k"],
            name=r.get("n"),
            brand=r.get("b"),
            road=r.get("r"),
            spaces=r.get("sp"),
            source=r["src"],
        )
        grid[(math.floor(site.lat / CELL), math.floor(site.lon / CELL))].append(site)
    return dict(grid)


@dataclass(frozen=True, slots=True)
class Candidate:
    site: Site
    drive_s: float  # driving time from departure to the point of the route nearest the site
    mile: float
    off_route_mi: float


def candidates(route: Route, max_off_mi: float = FAR_MI) -> list[Candidate]:
    """Sites within `max_off_mi` of the route, in driving order (one entry per site)."""
    grid = _index()
    best: dict[int, Candidate] = {}
    last_mile = -1.0
    for k, (lat, lon) in enumerate(route.coords):
        if route.cum_mi[k] - last_mile < 0.5 and k != len(route.coords) - 1:
            continue
        last_mile = route.cum_mi[k]
        ci, cj = math.floor(lat / CELL), math.floor(lon / CELL)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for site in grid.get((ci + di, cj + dj), ()):
                    off = haversine_mi((lat, lon), (site.lat, site.lon))
                    if off > max_off_mi:
                        continue
                    key = id(site)
                    if key not in best or off < best[key].off_route_mi:
                        best[key] = Candidate(site, route.cum_drive_s[k], route.cum_mi[k], off)
    return sorted(best.values(), key=lambda c: c.drive_s)


@dataclass(frozen=True, slots=True)
class Stop:
    kind: str  # "break" | "rest"
    drive_s: float  # driving time from departure when the truck stops
    mile: float
    point: LatLon
    duration_s: float
    site: Site | None  # None: no known truck parking before the limit
    off_route_mi: float
    early_s: float  # how long before the legal limit the truck stops


@dataclass(slots=True)
class Schedule:
    stops: list[Stop]

    def elapsed(self, drive_s: float) -> float:
        """Wall-clock seconds from departure when the truck has driven `drive_s`."""
        return drive_s + sum(s.duration_s for s in self.stops if s.drive_s < drive_s)

    def starts_at(self, stop: Stop) -> float:
        return self.elapsed(stop.drive_s)


def _pick(
    cands: list[Candidate], lo: float, hi: float, max_off: float, overnight: bool, tiers: int
) -> Candidate | None:
    """The latest candidate in [lo, hi] driving seconds, preferring better tiers."""
    pool = [
        c
        for c in cands
        if lo <= c.drive_s <= hi
        and c.off_route_mi <= max_off
        and c.site.tier <= tiers
        and (c.site.overnight_ok or not overnight)
    ]
    if not pool:
        return None
    top = min(c.site.tier for c in pool)
    return max((c for c in pool if c.site.tier == top), key=lambda c: c.drive_s)


def _latest(cands: list[Candidate], lo: float, hi: float, max_off: float) -> Candidate | None:
    """The latest overnight-capable candidate in [lo, hi], whatever its size."""
    pool = [
        c
        for c in cands
        if lo <= c.drive_s <= hi and c.off_route_mi <= max_off and c.site.overnight_ok
    ]
    return max(pool, key=lambda c: c.drive_s) if pool else None


def _point_at(route: Route, drive_s: float) -> tuple[LatLon, float]:
    from .checkpoints import mile_at_drive_seconds
    from .geo import interpolate_along

    mile = mile_at_drive_seconds(route, drive_s)
    return interpolate_along(route.coords, route.cum_mi, mile)[0], mile


def _stop(kind: str, route: Route, c: Candidate | None, limit_s: float) -> Stop:
    duration = BREAK_S if kind == "break" else REST_S
    if c is None:
        point, mile = _point_at(route, limit_s)
        return Stop(kind, limit_s, mile, point, duration, None, 0.0, 0.0)
    point, _ = _point_at(route, c.drive_s)
    return Stop(
        kind, c.drive_s, c.mile, point, duration, c.site, c.off_route_mi, limit_s - c.drive_s
    )


def plan(route: Route) -> Schedule:
    """Hours-of-service stops for one driver starting the trip fresh."""
    total = route.drive_s
    cands = candidates(route)
    stops: list[Stop] = []
    shift = 0.0  # driving seconds at the start of the current shift
    while total - shift > BREAK_DUE_S:
        brk = _pick(cands, shift + BREAK_EARLIEST_S, shift + BREAK_DUE_S, NEAR_MI, False, 0)
        brk = brk or _pick(cands, shift + BREAK_EARLIEST_S, shift + BREAK_DUE_S, NEAR_MI, False, 3)
        stops.append(_stop("break", route, brk, shift + BREAK_DUE_S))
        break_at = stops[-1].drive_s
        if total - shift <= SHIFT_DRIVE_S:
            break
        limit = min(shift + SHIFT_DRIVE_S, break_at + BREAK_DUE_S)
        # Resting early gives up driving hours, so lateness beats size once the best
        # tier is missing: a big site 9-11 h in, else the latest legal parking 9-11 h
        # in, else the latest from 8 h on.
        rest = _pick(cands, shift + REST_EARLIEST_S, limit, NEAR_MI, True, 1)
        rest = rest or _latest(cands, shift + REST_EARLIEST_S, limit, FAR_MI)
        rest = rest or _latest(cands, shift + REST_FALLBACK_EARLIEST_S, limit, FAR_MI)
        if rest is not None and rest.drive_s <= break_at:
            rest = None
        stops.append(_stop("rest", route, rest, limit))
        shift = stops[-1].drive_s
    return Schedule(stops)
