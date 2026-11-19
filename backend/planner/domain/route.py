"""A drivable route with the timing needed to know when the truck is where."""

from collections.abc import Sequence
from dataclasses import dataclass, field

from .geo import LatLon, cumulative_miles, haversine_mi

TRUCK_SPEED_CAP_MPH = 65.0


@dataclass(slots=True)
class Route:
    coords: list[LatLon]
    cum_mi: list[float]
    cum_drive_s: list[float]  # driving seconds from the start to each vertex
    source: str  # "valhalla" or "osrm"
    via: LatLon | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def distance_mi(self) -> float:
        return self.cum_mi[-1]

    @property
    def drive_s(self) -> float:
        return self.cum_drive_s[-1]


def _spread(
    cum_mi: Sequence[float], begin: int, end: int, seconds: float, out: list[float]
) -> None:
    """Add `seconds` across vertices begin..end in proportion to distance."""
    span = cum_mi[end] - cum_mi[begin]
    base = out[begin]
    for k in range(begin + 1, end + 1):
        frac = 1.0 if span <= 0 else (cum_mi[k] - cum_mi[begin]) / span
        out[k] = base + seconds * frac


def from_maneuvers(
    coords: list[LatLon],
    maneuvers: Sequence[tuple[int, int, float]],
    source: str = "valhalla",
) -> Route:
    """Build timing from Valhalla maneuvers: (begin_shape_index, end_shape_index, seconds).

    Valhalla reports time per maneuver, not per vertex, so each maneuver's time is spread
    over its stretch of road in proportion to distance.
    """
    cum_mi = cumulative_miles(coords)
    cum_s = [0.0] * len(coords)
    for begin, end, seconds in maneuvers:
        if end > begin:
            _spread(cum_mi, begin, end, seconds, cum_s)
        elif end == begin and end + 1 < len(cum_s):
            cum_s[end] = cum_s[begin]
    # Vertices a maneuver did not cover keep the previous time (monotonic).
    for k in range(1, len(cum_s)):
        if cum_s[k] < cum_s[k - 1]:
            cum_s[k] = cum_s[k - 1]
    return Route(coords=coords, cum_mi=cum_mi, cum_drive_s=cum_s, source=source)


def from_segment_durations(
    coords: list[LatLon],
    durations_s: Sequence[float],
    total_s: float,
    source: str = "osrm",
    speed_cap_mph: float = TRUCK_SPEED_CAP_MPH,
) -> Route:
    """Build timing from per-segment durations (OSRM annotations).

    Segment durations leave out turn costs, so they are scaled up to the route total.
    OSRM's demo routes cars, so any segment faster than a truck's cap is slowed to it.
    """
    cum_mi = cumulative_miles(coords)
    raw = sum(durations_s)
    scale = (total_s / raw) if raw > 0 and total_s > raw else 1.0
    cum_s = [0.0]
    for k, d in enumerate(durations_s):
        seg_mi = cum_mi[k + 1] - cum_mi[k]
        t = d * scale
        min_t = seg_mi / speed_cap_mph * 3600
        cum_s.append(cum_s[-1] + max(t, min_t))
    # Defensive: annotation count must match segment count.
    while len(cum_s) < len(coords):
        cum_s.append(cum_s[-1])
    return Route(coords=coords, cum_mi=cum_mi, cum_drive_s=cum_s[: len(coords)], source=source)


SPUR_WINDOW_MI = 20.0  # look this far either side of a join for an out-and-back spur
SPUR_SAME_POINT_MI = 0.06  # about 100 m: "back where it left"
SPUR_MIN_MI = 1.0  # shorter loops are ordinary interchange ramps


def _cut_spur(coords: list[LatLon], cum_s: list[float], joint: int) -> int:
    """Remove an out-and-back detour around vertex `joint`; return vertices removed.

    Forcing a leg to end at a point the truck router would not have driven through makes
    it drive out to that point and straight back. If the route leaves a spot before the
    joint and returns to the same spot after it, the excursion is cut out, with its time.
    """
    cum = cumulative_miles(coords)
    lo = joint
    while lo > 0 and cum[joint] - cum[lo - 1] <= SPUR_WINDOW_MI:
        lo -= 1
    hi = joint
    while hi < len(coords) - 1 and cum[hi + 1] - cum[joint] <= SPUR_WINDOW_MI:
        hi += 1
    # Hash the points after the joint on a ~200 m grid, so each point before it checks
    # only its neighbourhood (linear instead of quadratic over thousands of vertices).
    cell = 0.002
    after: dict[tuple[int, int], list[int]] = {}
    for j in range(joint + 1, hi + 1):
        after.setdefault((int(coords[j][0] // cell), int(coords[j][1] // cell)), []).append(j)
    for i in range(lo, joint):  # earliest departure point gives the whole spur
        ci, cj = int(coords[i][0] // cell), int(coords[i][1] // cell)
        near = [
            j for di in (-1, 0, 1) for dj in (-1, 0, 1) for j in after.get((ci + di, cj + dj), [])
        ]
        for j in sorted(near, reverse=True):  # latest return to it
            if (
                cum[j] - cum[i] >= SPUR_MIN_MI
                and haversine_mi(coords[i], coords[j]) <= SPUR_SAME_POINT_MI
            ):
                spent = cum_s[j] - cum_s[i]
                del coords[i + 1 : j]
                del cum_s[i + 1 : j]
                for k in range(i + 1, len(cum_s)):
                    cum_s[k] -= spent
                return j - i - 1
    return 0


def join(legs: Sequence[Route], source: str) -> Route:
    """Stitch consecutive legs into one route, carrying distance and time across joins."""
    coords: list[LatLon] = []
    cum_s: list[float] = []
    joints: list[int] = []
    for leg in legs:
        offset = cum_s[-1] if cum_s else 0.0
        skip = 1 if coords and coords[-1] == leg.coords[0] else 0
        if coords:
            joints.append(len(coords) - 1)
        coords.extend(leg.coords[skip:])
        cum_s.extend(offset + t for t in leg.cum_drive_s[skip:])
    removed = 0
    for joint in joints:
        removed += _cut_spur(coords, cum_s, joint - removed)
    joined = Route(coords=coords, cum_mi=cumulative_miles(coords), cum_drive_s=cum_s, source=source)
    joined.warnings = sorted({w for leg in legs for w in leg.warnings})
    return joined
