"""A drivable route with the timing needed to know when the truck is where."""

from collections.abc import Sequence
from dataclasses import dataclass, field

from .geo import LatLon, cumulative_miles

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
