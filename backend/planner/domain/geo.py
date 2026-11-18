"""Small, dependency-free geometry for routes on the Earth's surface.

Coordinates are (lat, lon) tuples in degrees everywhere in the backend. They are
converted to GeoJSON's [lon, lat] order only at the API boundary.
"""

import itertools
import math
from bisect import bisect_right
from collections.abc import Sequence

LatLon = tuple[float, float]

EARTH_RADIUS_MI = 3958.7613
KM_PER_MI = 1.609344


def haversine_mi(a: LatLon, b: LatLon) -> float:
    """Great-circle distance in miles. Within 0.1% of ellipsoidal distance on US routes."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_MI * math.asin(min(1.0, math.sqrt(h)))


def cumulative_miles(coords: Sequence[LatLon]) -> list[float]:
    """Distance from the start to every vertex."""
    out = [0.0]
    for prev, cur in itertools.pairwise(coords):
        out.append(out[-1] + haversine_mi(prev, cur))
    return out


def interpolate_along(
    coords: Sequence[LatLon], cum_mi: Sequence[float], mile: float
) -> tuple[LatLon, int, float]:
    """Point at `mile` along the line, plus the segment index and fraction used.

    Linear interpolation in lat/lon is accurate enough here: segments from a router's
    full-resolution geometry are tens to hundreds of metres long.
    """
    if mile <= 0:
        return coords[0], 0, 0.0
    if mile >= cum_mi[-1]:
        return coords[-1], len(coords) - 2, 1.0
    i = bisect_right(cum_mi, mile) - 1
    seg = cum_mi[i + 1] - cum_mi[i]
    f = 0.0 if seg == 0 else (mile - cum_mi[i]) / seg
    a, b = coords[i], coords[i + 1]
    return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f), i, f


def resample(coords: Sequence[LatLon], step_mi: float) -> list[LatLon]:
    """Points every `step_mi` along the line, always including both ends."""
    cum = cumulative_miles(coords)
    total = cum[-1]
    n = max(1, math.ceil(total / step_mi))
    return [interpolate_along(coords, cum, total * k / n)[0] for k in range(n + 1)]


def overlap_ratio(a: Sequence[LatLon], b: Sequence[LatLon], tol_mi: float = 0.6) -> float:
    """Share of route `a` that lies within `tol_mi` of route `b` (0 to 1).

    Uses a coarse lat/lon hash of `b`'s resampled points, so it is O(n) and good enough
    to tell real alternatives from near-duplicates.
    """
    cell = 0.01  # degrees, about 1.1 km of latitude
    bucket: set[tuple[int, int]] = set()
    for lat, lon in resample(b, 0.3):
        bucket.add((round(lat / cell), round(lon / cell)))
    pts = resample(a, 0.3)
    reach = max(1, math.ceil((tol_mi / 69.0) / cell))
    hits = 0
    for lat, lon in pts:
        ci, cj = round(lat / cell), round(lon / cell)
        if any(
            (ci + di, cj + dj) in bucket
            for di in range(-reach, reach + 1)
            for dj in range(-reach, reach + 1)
        ):
            hits += 1
    return hits / len(pts)


def offset_point(origin: LatLon, dest: LatLon, along: float, side_mi: float) -> LatLon:
    """A point `along` (0..1) of the way from origin to dest, pushed `side_mi` sideways.

    Positive `side_mi` is to the left of the travel direction. Used to pick via points
    that force a genuinely different third route.
    """
    lat = origin[0] + (dest[0] - origin[0]) * along
    lon = origin[1] + (dest[1] - origin[1]) * along
    # Local flat-earth frame in miles.
    kx = 69.172 * math.cos(math.radians(lat))
    ky = 69.0
    dx = (dest[1] - origin[1]) * kx
    dy = (dest[0] - origin[0]) * ky
    norm = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / norm, dx / norm  # left normal
    return lat + ny * side_mi / ky, lon + nx * side_mi / kx
