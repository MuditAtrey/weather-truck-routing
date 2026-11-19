"""The two use cases: plan a trip, then score it once the browser has the forecasts.

Why two steps: Open-Meteo's free tier is limited per IP address, and serverless hosts
share outgoing IPs between many tenants. So the browser fetches the raw forecasts with
its own quota, and Django does all of the scoring. The plan is handed to the browser as
a signed token, so /score can trust the checkpoints and times without storing anything.
"""

import functools
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.core import signing
from timezonefinder import TimezoneFinder

from .domain import checkpoints as cp
from .domain.forecast import HOUR, Series, ceil_hour, floor_hour, sample_at, sample_hour
from .domain.geo import LatLon, haversine_mi
from .domain.grid import corridor
from .domain.scoring import WindMode, point_risk, rank, summarize
from .providers.router import find_routes
from .schemas import PlanIn, ScoreIn

TOKEN_SALT = "plan.v1"  # noqa: S105 (a namespace, not a secret)
TOKEN_MAX_AGE_S = 2 * 3600
HEATMAP_HOURS = 48
MAX_DEPARTURE_AHEAD = timedelta(hours=72)
DEPARTURE_GRACE = timedelta(minutes=30)
MIN_TRIP_MI = 1.0
POINT_ROUND = 1  # decimals: checkpoints closer than ~5 km share one forecast request


class PlanError(Exception):
    def __init__(self, code: str, detail: str, status: int = 422) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status = status


@functools.cache
def _tz_finder() -> TimezoneFinder:
    return TimezoneFinder()


def timezone_at(point: LatLon) -> str:
    return _tz_finder().timezone_at(lat=point[0], lng=point[1]) or "UTC"


def resolve_departure(local: str, tz_name: str, now: datetime) -> datetime:
    """Interpret a wall-clock time at the origin, rejecting times that do not exist."""
    naive = datetime.fromisoformat(local)
    tz = ZoneInfo(tz_name)
    aware = naive.replace(tzinfo=tz)
    # A time skipped by a spring-forward change does not survive a round trip via UTC.
    if aware.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != naive:
        raise PlanError(
            "departure_nonexistent", f"{local} does not exist in {tz_name} (clock change)"
        )
    utc = aware.astimezone(UTC)
    if utc < now - DEPARTURE_GRACE:
        raise PlanError("departure_past", "Departure is in the past")
    if utc > now + MAX_DEPARTURE_AHEAD:
        raise PlanError("departure_too_far", "Departure must be within the next 72 hours")
    return utc


@dataclass(slots=True)
class _Points:
    """Deduplicated weather locations, each with the hour range the scoring needs."""

    keys: dict[tuple[float, float], int]
    ranges: list[list[int]]
    coords: list[LatLon]

    @classmethod
    def empty(cls) -> "_Points":
        return cls({}, [], [])

    def add(self, point: LatLon, start: int, end: int, rounding: int = POINT_ROUND) -> int:
        key = (round(point[0], rounding), round(point[1], rounding))
        idx = self.keys.get(key)
        if idx is None:
            idx = len(self.ranges)
            self.keys[key] = idx
            self.ranges.append([start, end])
            self.coords.append(key)
        else:
            self.ranges[idx][0] = min(self.ranges[idx][0], start)
            self.ranges[idx][1] = max(self.ranges[idx][1], end)
        return idx


def _feature(
    geometry: dict[str, Any], props: dict[str, Any], fid: int | None = None
) -> dict[str, Any]:
    f: dict[str, Any] = {"type": "Feature", "geometry": geometry, "properties": props}
    if fid is not None:
        f["id"] = fid
    return f


async def plan(req: PlanIn, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    origin: LatLon = (req.origin.lat, req.origin.lon)
    dest: LatLon = (req.destination.lat, req.destination.lon)
    if haversine_mi(origin, dest) < MIN_TRIP_MI:
        raise PlanError("same_place", "Origin and destination are less than a mile apart")

    tz_name = timezone_at(origin)
    departure = resolve_departure(req.departure_local, tz_name, now)
    dep_epoch = int(departure.timestamp())

    result = await find_routes(origin, dest, req.cargo_lb)

    points = _Points.empty()
    route_features: list[dict[str, Any]] = []
    cp_features: list[dict[str, Any]] = []
    token_cps: list[list[float | int]] = []
    token_routes: list[list[int | bool]] = []
    for rid, route in enumerate(result.routes):
        cps = cp.build(route, req.interval_mi, req.hos)
        trip_s = cps[-1].elapsed_s
        token_routes.append([round(trip_s), "crosses_canada" in route.warnings])
        route_features.append(
            _feature(
                {
                    "type": "LineString",
                    "coordinates": [[round(lon, 5), round(lat, 5)] for lat, lon in route.coords],
                },
                {
                    "id": rid,
                    "name": chr(65 + rid),
                    "distance_mi": round(route.distance_mi, 1),
                    "drive_s": round(route.drive_s),
                    "trip_s": round(trip_s),
                    "source": route.source,
                    "via": bool(route.via),
                    "warnings": sorted(set(route.warnings)),
                },
                rid + 1,
            )
        )
        for c in cps:
            eta = dep_epoch + c.elapsed_s
            wp = points.add(c.point, floor_hour(eta), ceil_hour(eta))
            token_cps.append([rid, round(c.represented_mi, 3), round(eta), wp])
            cp_features.append(
                _feature(
                    {"type": "Point", "coordinates": [round(c.point[1], 5), round(c.point[0], 5)]},
                    {
                        "route": rid,
                        "index": c.index,
                        "mile": round(c.mile, 1),
                        "represented_mi": round(c.represented_mi, 2),
                        "eta": round(eta),
                        "drive_s": round(c.drive_s),
                    },
                    len(cp_features) + 1,
                )
            )

    hours = [floor_hour(dep_epoch) + k * HOUR for k in range(HEATMAP_HOURS + 1)]
    cells = corridor([r.coords for r in result.routes])
    cell_points = [points.add(c.center, hours[0], hours[-1], rounding=3) for c in cells]
    grid_features = [
        _feature({"type": "Polygon", "coordinates": [c.ring]}, {"cell": i}, c.id)
        for i, c in enumerate(cells)
    ]

    token = signing.dumps(
        {
            "cargo": req.cargo_lb,
            "routes": token_routes,
            "cps": token_cps,
            "cells": cell_points,
            "hours": [hours[0], len(hours)],
            "wp": points.ranges,
        },
        salt=TOKEN_SALT,
        compress=True,
    )
    return {
        "token": token,
        "timezone": tz_name,
        "departure": dep_epoch,
        "hours": hours,
        "router": {
            "provider": result.provider,
            "profile": "truck" if result.provider == "valhalla" else "car_capped",
            "fallback_reason": result.fallback_reason,
        },
        "warnings": result.warnings,
        "routes": {"type": "FeatureCollection", "features": route_features},
        "checkpoints": {"type": "FeatureCollection", "features": cp_features},
        "grid": {"type": "FeatureCollection", "features": grid_features},
        "weather_points": [
            {"lat": lat, "lon": lon, "start": s, "end": e}
            for (lat, lon), (s, e) in zip(points.coords, points.ranges, strict=True)
        ],
    }


def _level_char(level: int | None) -> str:
    return "u" if level is None else str(level)


def score(req: ScoreIn) -> dict[str, Any]:
    try:
        tok = signing.loads(req.token, salt=TOKEN_SALT, max_age=TOKEN_MAX_AGE_S)
    except signing.SignatureExpired as exc:
        raise PlanError("plan_expired", "This plan is over 2 hours old; plan again") from exc
    except signing.BadSignature as exc:
        raise PlanError("bad_token", "Plan token is invalid") from exc

    ranges: list[list[int]] = tok["wp"]
    if len(req.weather) != len(ranges):
        raise PlanError("weather_mismatch", "Weather must have one entry per weather point")
    series: list[Series] = []
    for pw, (start, end) in zip(req.weather, ranges, strict=True):
        n = (end - start) // HOUR + 1
        arrays = (pw.wind, pw.gust, pw.rain, pw.showers, pw.snow)
        if any(len(a) != n for a in arrays):
            raise PlanError("weather_mismatch", "Weather arrays do not match the requested hours")
        for a, hi in zip(arrays, (250, 300, 20, 20, 30), strict=True):
            if any(v is not None and not 0 <= v <= hi for v in a):
                raise PlanError(
                    "weather_out_of_range", "A weather value is outside physical limits"
                )
        series.append(Series(start, pw.wind, pw.gust, pw.rain, pw.showers, pw.snow))

    cargo: int = tok["cargo"]
    samples = [sample_at(series[wp], eta) for _, _, eta, wp in tok["cps"]]
    hour0, n_hours = tok["hours"]
    cell_series = [series[wp] for wp in tok["cells"]]

    out: dict[str, Any] = {
        "conditions": [
            {"wind": s.wind_mph, "gust": s.gust_mph, "rain": s.rain_in_hr, "snow": s.snow_in_hr}
            for s in samples
        ]
    }
    modes: tuple[WindMode, ...] = ("sustained", "gust")
    for mode in modes:
        risks = [point_risk(s, cargo, mode) for s in samples]
        summaries = []
        for rid, (trip_s, leaves_us) in enumerate(tok["routes"]):
            idx = [i for i, c in enumerate(tok["cps"]) if c[0] == rid]
            summaries.append(
                summarize(
                    rid,
                    [risks[i] for i in idx],
                    [tok["cps"][i][1] for i in idx],
                    trip_s,
                    leaves_us,
                )
            )
        ranking = rank(summaries)
        heatmap = []
        for k in range(n_hours):
            hour_end = hour0 + k * HOUR
            heatmap.append(
                "".join(
                    _level_char(point_risk(sample_hour(s, hour_end), cargo, mode).level)
                    for s in cell_series
                )
            )
        out[mode] = {
            "checkpoint_levels": "".join(_level_char(r.level) for r in risks),
            "checkpoint_drivers": "".join((r.driver or "-")[0] for r in risks),
            "routes": [
                {
                    "id": s.route_id,
                    "miles_by_level": [round(m, 1) for m in s.miles_by_level],
                    "unknown_mi": round(s.unknown_mi, 1),
                    "avg_risk": None if s.avg_risk is None else round(s.avg_risk, 3),
                    "worst": None if s.worst is None else int(s.worst),
                }
                for s in summaries
            ],
            "ranking": {
                "order": ranking.order,
                "recommended": ranking.recommended,
                "status": ranking.status,
                "reasons": ranking.reasons,
            },
            "heatmap": heatmap,
        }
    return out
