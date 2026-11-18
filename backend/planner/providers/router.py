"""Getting three sensible truck routes from free public routers.

1. Trips under Valhalla's distance limit use its truck profile. Longer trips, or any
   time Valhalla is down, use the OSRM demo (car profile, speeds capped for a truck).
2. Valhalla gets a head start. If it has not answered after HEDGE_AFTER_S, OSRM is asked
   too and the first good answer wins, so a struggling server costs seconds, not minutes.
3. Routers often return fewer than 3 distinct routes. The gap is filled by routing
   through a point pushed sideways from the straight line, keeping a candidate only if
   it is genuinely different and not absurdly longer.
"""

import asyncio
import hashlib
import itertools
import logging
from dataclasses import dataclass, field

from django.conf import settings
from django.core.cache import cache

from ..domain.geo import KM_PER_MI, LatLon, haversine_mi, offset_point, overlap_ratio
from ..domain.route import Route
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


@dataclass(slots=True)
class RoutingResult:
    routes: list[Route]
    provider: str  # "valhalla" or "osrm"
    fallback_reason: str | None = None  # why OSRM was used
    warnings: list[str] = field(default_factory=list)


def _cache_key(origin: LatLon, dest: LatLon, cargo_lb: int, use_valhalla: bool) -> str:
    raw = (
        f"{origin[0]:.4f},{origin[1]:.4f}|{dest[0]:.4f},{dest[1]:.4f}"
        f"|{cargo_lb // 1000}|{use_valhalla}"
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
        warnings += r.warnings

    result = RoutingResult(routes[:TARGET_ROUTES], provider, reason, sorted(set(warnings)))
    cache.set(key, result, CACHE_S)
    return result
