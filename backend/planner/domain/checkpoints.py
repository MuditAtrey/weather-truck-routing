"""Weather checkpoints along a route, each with the truck's arrival time.

A checkpoint is placed every `interval_mi`, plus one at the destination. Each checkpoint
stands for the road halfway to its neighbours, so the represented miles of all
checkpoints add up exactly to the route length:

    mile:   0 ----- 25 ----- 50 --- 62 (destination)
    covers: 0-12.5  12.5-37.5 37.5-56 56-62
"""

import math
from bisect import bisect_right
from dataclasses import dataclass

from . import hos
from .geo import LatLon, interpolate_along
from .route import Route

INTERVALS_MI = (10, 25, 50)


@dataclass(frozen=True, slots=True)
class Checkpoint:
    index: int
    mile: float
    point: LatLon
    represented_mi: float
    drive_s: float  # driving time from departure
    elapsed_s: float  # wall-clock time from departure (includes HOS stops if enabled)


def drive_seconds_at(route: Route, mile: float) -> float:
    cum = route.cum_mi
    if mile <= 0:
        return 0.0
    if mile >= cum[-1]:
        return route.cum_drive_s[-1]
    i = bisect_right(cum, mile) - 1
    seg = cum[i + 1] - cum[i]
    f = 0.0 if seg == 0 else (mile - cum[i]) / seg
    return route.cum_drive_s[i] + (route.cum_drive_s[i + 1] - route.cum_drive_s[i]) * f


def checkpoint_miles(total_mi: float, interval_mi: float) -> list[float]:
    n = math.floor(total_mi / interval_mi)
    miles = [k * interval_mi for k in range(n + 1)]
    if total_mi - miles[-1] > 1e-6:
        miles.append(total_mi)
    return miles


def build(route: Route, interval_mi: float, with_hos: bool) -> list[Checkpoint]:
    miles = checkpoint_miles(route.distance_mi, interval_mi)
    out: list[Checkpoint] = []
    for k, mile in enumerate(miles):
        left = 0.0 if k == 0 else (mile - miles[k - 1]) / 2
        right = 0.0 if k == len(miles) - 1 else (miles[k + 1] - mile) / 2
        represented = left + right
        point, _, _ = interpolate_along(route.coords, route.cum_mi, mile)
        drive_s = drive_seconds_at(route, mile)
        elapsed_s = hos.elapsed_hours(drive_s / 3600) * 3600 if with_hos else drive_s
        out.append(
            Checkpoint(
                index=k,
                mile=mile,
                point=point,
                represented_mi=represented,
                drive_s=drive_s,
                elapsed_s=elapsed_s,
            )
        )
    return out


def mile_at_drive_seconds(route: Route, seconds: float) -> float:
    """Inverse of drive_seconds_at: how far the truck has driven after `seconds`."""
    t = route.cum_drive_s
    if seconds <= 0:
        return 0.0
    if seconds >= t[-1]:
        return route.distance_mi
    i = bisect_right(t, seconds) - 1
    span = t[i + 1] - t[i]
    f = 0.0 if span == 0 else (seconds - t[i]) / span
    return route.cum_mi[i] + (route.cum_mi[i + 1] - route.cum_mi[i]) * f


@dataclass(frozen=True, slots=True)
class Stop:
    kind: str  # "break" (30 min) or "rest" (10 h)
    point: LatLon
    mile: float
    elapsed_s: float  # wall-clock time from departure when the stop starts
    duration_s: float


def rest_stops(route: Route) -> list[Stop]:
    """Where the hours-of-service breaks and rests fall on this route."""
    out: list[Stop] = []
    for drive_h, kind, hours in hos.stops(route.drive_s / 3600):
        mile = mile_at_drive_seconds(route, drive_h * 3600)
        point, _, _ = interpolate_along(route.coords, route.cum_mi, mile)
        elapsed = hos.elapsed_hours(drive_h) * 3600
        out.append(Stop(kind, point, mile, elapsed, hours * 3600))
    return out
