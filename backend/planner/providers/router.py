"""Getting three sensible truck routes from free public routers.

1. Trips under Valhalla's distance limit use its truck profile. Longer trips, or any
   time Valhalla is down, use the OSRM demo (car profile, speeds capped for a truck).
2. Valhalla gets a head start. If it has not answered after HEDGE_AFTER_S, OSRM is asked
   too and the first good answer wins, so a struggling server costs seconds, not minutes.
3. Routers often return fewer than 3 distinct routes. The gap is filled by routing
   through a point pushed sideways from the straight line, keeping a candidate only if
   it is genuinely different and not absurdly longer.
4. Trips over Valhalla's limit are still truck-routed, in legs: OSRM sketches three
   corridors, each corridor is cut into legs short enough for Valhalla, every leg is
   truck-routed (arriving and leaving in the direction of travel so joins have no
   U-turns), and the legs are stitched together. If any leg fails, the plan keeps the
   OSRM routes and says so.
"""

import asyncio
import hashlib
import itertools
import logging
from dataclasses import dataclass, field

from django.conf import settings
from django.core.cache import cache

from ..domain.borders import crosses_canada
from ..domain.geo import (
    KM_PER_MI,
    LatLon,
    bearing_deg,
    haversine_mi,
    interpolate_along,
    offset_point,
    overlap_ratio,
)
from ..domain.route import Route, join
from . import osrm, valhalla
from .errors import RoutingError

log = logging.getLogger(__name__)

HEDGE_AFTER_S = 2.5
TARGET_ROUTES = 3
DUPLICATE_OVERLAP = 0.85  # above this, two routes are the same road
VIA_MAX_OVERLAP = 0.70  # a filled-in route must differ this much from every kept route
VIA_MAX_SLOWDOWN = 1.35  # and be at most 35% slower than the fastest
SNAP_WARN_MI = 1.5
SNAP_REJECT_MI = 6.5
CACHE_S = 1800
LEG_MI = 650.0  # road miles per truck leg; straight-line is always shorter, so under the cap
LEGS_BUDGET_S = 40.0  # give up on truck legs (keep OSRM) if they take longer than this
LEG_CONCURRENCY = 2  # the FOSSGIS policy allows two connections
CUT_SEARCH_MI = 30


@dataclass(slots=True)
class RoutingResult:
    routes: list[Route]
    provider: str  # "valhalla" or "osrm"
    fallback_reason: str | None = None  # why OSRM was used
    warnings: list[str] = field(default_factory=list)
    legs: int = 1  # most Valhalla requests stitched into one route


def _cache_key(origin: LatLon, dest: LatLon, cargo_lb: int, use_valhalla: bool) -> str:
    raw = (
        f"{origin[0]:.4f},{origin[1]:.4f}|{dest[0]:.4f},{dest[1]:.4f}"
        f"|{cargo_lb // 1000}|{use_valhalla}|{settings.VALHALLA_ENABLED}"
    )
    return "routes:" + hashlib.sha256(raw.encode()).hexdigest()[:24]


def straight_km(points: list[LatLon]) -> float:
    return sum(haversine_mi(a, b) for a, b in itertools.pairwise(points)) * KM_PER_MI


def _check_snap(route: Route, origin: LatLon, dest: LatLon) -> list[str]:
    worst = max(haversine_mi(origin, route.coords[0]), haversine_mi(dest, route.coords[-1]))
    if worst > SNAP_REJECT_MI:
        raise RoutingError("not_on_road", route.source, f"nearest road {worst:.1f} mi away")
    return ["snapped_far"] if worst > SNAP_WARN_MI else []


async def _hedged(
    origin: LatLon, dest: LatLon, cargo_lb: int
) -> tuple[list[Route], str, str | None]:
    """Valhalla first; OSRM in parallel if Valhalla is slow; OSRM alone if it fails."""
    v_task = asyncio.create_task(valhalla.fetch([origin, dest], cargo_lb))
    done, _ = await asyncio.wait({v_task}, timeout=HEDGE_AFTER_S)
    if done:
        try:
            return v_task.result(), "valhalla", None
        except RoutingError as exc:
            if not exc.retryable:
                raise
            log.warning("valhalla failed, falling back to osrm: %s", exc)
            reason = "distance_cap" if exc.kind == "too_far" else "valhalla_unavailable"
            return await osrm.fetch([origin, dest]), "osrm", reason

    o_task = asyncio.create_task(osrm.fetch([origin, dest]))
    pending = {v_task, o_task}
    first_error: RoutingError | None = None
    while pending:
        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            try:
                routes = task.result()
            except RoutingError as exc:
                if task is v_task and not exc.retryable:
                    o_task.cancel()
                    raise
                first_error = first_error or exc
                continue
            for other in pending:
                other.cancel()
            if task is v_task:
                return routes, "valhalla", None
            return routes, "osrm", "valhalla_slow"
    raise first_error or RoutingError("unavailable", "router")


def _distinct(routes: list[Route]) -> list[Route]:
    kept: list[Route] = []
    for r in routes:
        if all(overlap_ratio(r.coords, k.coords) < DUPLICATE_OVERLAP for k in kept):
            kept.append(r)
    return kept


def _via_candidates(origin: LatLon, dest: LatLon) -> list[LatLon]:
    dist = haversine_mi(origin, dest)
    near = min(150.0, max(8.0, dist * 0.15))
    far = min(250.0, max(15.0, dist * 0.3))
    return [
        offset_point(origin, dest, 0.5, near),
        offset_point(origin, dest, 0.5, -near),
        offset_point(origin, dest, 0.5, far),
        offset_point(origin, dest, 0.5, -far),
    ]


async def _fill(
    routes: list[Route], origin: LatLon, dest: LatLon, cargo_lb: int, provider: str
) -> list[Route]:
    attempts = 0
    for via in _via_candidates(origin, dest):
        if len(routes) >= TARGET_ROUTES or attempts >= 3:
            break
        points = [origin, via, dest]
        if provider == "valhalla" and straight_km(points) >= valhalla.MAX_STRAIGHT_LINE_KM:
            continue
        attempts += 1
        try:
            if provider == "valhalla":
                found = await valhalla.fetch(points, cargo_lb, alternates=0)
            else:
                found = await osrm.fetch(points, alternatives=False)
        except RoutingError as exc:
            log.info("via %s rejected: %s", via, exc)
            continue
        cand = found[0]
        fastest = min(r.drive_s for r in routes)
        shortest = min(r.distance_mi for r in routes)
        if cand.drive_s > fastest * VIA_MAX_SLOWDOWN or cand.distance_mi > shortest * 1.5:
            continue
        if any(overlap_ratio(cand.coords, k.coords) >= VIA_MAX_OVERLAP for k in routes):
            continue
        cand.via = via
        routes.append(cand)
    return routes


def _turn_at(route: Route, mile: float) -> tuple[float, float]:
    """Turning angle over +-1 mile around `mile` (degrees), and the heading through it."""
    before = interpolate_along(route.coords, route.cum_mi, max(0.0, mile - 1))[0]
    here = interpolate_along(route.coords, route.cum_mi, mile)[0]
    after = interpolate_along(route.coords, route.cum_mi, min(route.distance_mi, mile + 1))[0]
    a, b = bearing_deg(before, here), bearing_deg(here, after)
    return abs((b - a + 180) % 360 - 180), bearing_deg(before, after)


def leg_points(route: Route) -> tuple[list[LatLon], list[float]]:
    """Cut points (with the direction of travel at each) splitting a route into legs.

    Each cut is moved, within CUT_SEARCH_MI of its even spacing, to the straightest bit
    of road nearby. Cutting on a curve or at an interchange makes the router loop round
    to arrive in the forced direction.
    """
    n = max(1, round(route.distance_mi / LEG_MI + 0.49))
    points = [route.coords[0]]
    headings = [0.0]
    for k in range(1, n):
        nominal = route.distance_mi * k / n
        candidates = [nominal + d for d in range(-CUT_SEARCH_MI, CUT_SEARCH_MI + 1, 2)]
        best = min(candidates, key=lambda m: (round(_turn_at(route, m)[0]), abs(m - nominal)))
        points.append(interpolate_along(route.coords, route.cum_mi, best)[0])
        headings.append(_turn_at(route, best)[1])
    points.append(route.coords[-1])
    headings.append(0.0)
    return points, headings


async def _truck_by_legs(skeleton: Route, cargo_lb: int, sem: asyncio.Semaphore) -> Route:
    points, headings = leg_points(skeleton)

    async def leg(i: int) -> Route:
        start_heading = headings[i] if i > 0 else None
        end_heading = headings[i + 1] if i + 1 < len(points) - 1 else None
        async with sem:
            found = await valhalla.fetch(
                [points[i], points[i + 1]],
                cargo_lb,
                alternates=0,
                headings=[start_heading, end_heading],
            )
        return found[0]

    legs = await asyncio.gather(*(leg(i) for i in range(len(points) - 1)))
    route = join(legs, source="valhalla")
    route.via = skeleton.via
    return route


async def _truck_long_haul(skeletons: list[Route], cargo_lb: int) -> tuple[list[Route], int] | None:
    """Truck versions of long OSRM routes, or None if any leg fails or time runs out."""
    sem = asyncio.Semaphore(LEG_CONCURRENCY)
    try:
        async with asyncio.timeout(LEGS_BUDGET_S):
            routes = [await _truck_by_legs(s, cargo_lb, sem) for s in skeletons]
    except (RoutingError, TimeoutError) as exc:
        log.warning("truck legs failed, keeping OSRM routes: %r", exc)
        return None
    return routes, max(len(leg_points(s)[0]) - 1 for s in skeletons)


async def find_routes(origin: LatLon, dest: LatLon, cargo_lb: int) -> RoutingResult:
    use_valhalla = (
        settings.VALHALLA_ENABLED and straight_km([origin, dest]) < valhalla.MAX_STRAIGHT_LINE_KM
    )
    key = _cache_key(origin, dest, cargo_lb, use_valhalla)
    cached = cache.get(key)
    if cached is not None:
        return cached

    if use_valhalla:
        routes, provider, reason = await _hedged(origin, dest, cargo_lb)
    else:
        routes, provider = await osrm.fetch([origin, dest]), "osrm"
        reason = "valhalla_disabled" if not settings.VALHALLA_ENABLED else "distance_cap"

    warnings: list[str] = []
    for r in routes:
        warnings += _check_snap(r, origin, dest)
    routes = _distinct(routes)
    if len(routes) < TARGET_ROUTES:
        routes = await _fill(routes, origin, dest, cargo_lb, provider)
    if len(routes) < TARGET_ROUTES:
        warnings.append("fewer_than_3_routes")
    for r in routes:
        if crosses_canada(r.coords):
            r.warnings.append("crosses_canada")
        warnings += r.warnings

    legs = 1
    routes = routes[:TARGET_ROUTES]
    if provider == "osrm" and reason == "distance_cap" and settings.VALHALLA_ENABLED:
        truck = await _truck_long_haul(routes, cargo_lb)
        truck_warnings: list[str] = []
        try:
            if truck is None:
                raise RoutingError("unavailable", "valhalla", "legs")
            for r in truck[0]:
                truck_warnings += _check_snap(r, origin, dest)
                if crosses_canada(r.coords):
                    r.warnings.append("crosses_canada")
                truck_warnings += r.warnings
        except RoutingError:
            reason = "valhalla_legs_failed"
        else:
            assert truck is not None
            routes, legs = truck
            provider, reason = "valhalla", None
            warnings = [w for w in warnings if w != "crosses_canada"] + truck_warnings
            if len(_distinct(routes)) < len(routes):
                warnings.append("truck_routes_converge")

    result = RoutingResult(routes, provider, reason, sorted(set(warnings)), legs)
    cache.set(key, result, CACHE_S)
    return result
