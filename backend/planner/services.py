"""The two use cases: plan a trip, then score it once the browser has the forecasts.

Why two steps: Open-Meteo's free tier is limited per IP address, and serverless hosts
share outgoing IPs between many tenants. So the browser fetches the raw forecasts with
its own quota, and Django does all of the scoring. The plan is handed to the browser as
a signed token, so /score can trust the checkpoints and times without storing anything.
"""

import base64
import functools
import itertools
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.core import signing
from timezonefinder import TimezoneFinder

from .domain import checkpoints as cp
from .domain import rest_stops
from .domain.forecast import HOUR, Series, ceil_hour, floor_hour, sample_at, sample_hour
from .domain.geo import LatLon, haversine_mi
from .domain.grid import corridor
from .domain.route import Route
from .domain.scoring import WindMode, point_index, point_risk, rank, summarize
from .providers import openmeteo
from .providers.router import find_trip
from .schemas import PlanIn, PointWeather, ScoreIn

TOKEN_SALT = "plan.v1"  # noqa: S105 (a namespace, not a secret)
TOKEN_MAX_AGE_S = 2 * 3600
HEATMAP_HOURS = 48  # the brief's window; the slider extends to cover longer trips
MAX_HEATMAP_HOURS = 120
MAX_DEPARTURE_AHEAD = timedelta(days=7)  # forecasts run 16 days; later hours are less reliable
DEPARTURE_GRACE = timedelta(minutes=30)
MIN_TRIP_MI = 1.0
WEATHER_REQUEST_MAX = 1000  # Open-Meteo locations per request
MAX_CELLS = 320
MIN_CELLS = 120
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
        raise PlanError("departure_too_far", "Departure must be within the next 7 days")
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
    vias: list[LatLon] = [(v.lat, v.lon) for v in req.via]
    through = [origin, *vias, dest]
    if any(haversine_mi(a, b) < MIN_TRIP_MI for a, b in itertools.pairwise(through)):
        raise PlanError(
            "same_place",
            "Origin and destination are less than a mile apart"
            if not vias
            else "Two places in a row are less than a mile apart",
        )

    tz_name = timezone_at(origin)
    departure = resolve_departure(req.departure_local, tz_name, now)
    dep_epoch = int(departure.timestamp())

    trip = await find_trip(through, req.cargo_lb)
    result = trip.routing

    points = _Points.empty()
    route_features: list[dict[str, Any]] = []
    cp_features: list[dict[str, Any]] = []
    token_cps: list[list[float | int]] = []
    token_routes: list[list[int | bool]] = []
    for rid, route in enumerate(result.routes):
        schedule = rest_stops.plan(route) if req.hos else None
        cps = cp.build(route, req.interval_mi, schedule)
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
                    "stops": _stops_json(route, schedule, dep_epoch, req, trip.stop_miles[rid]),
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

    checkpoint_points = len(points.ranges)  # these come first, so routes can be scored early
    longest_trip_h = max(trip for trip, _ in token_routes) / HOUR if token_routes else 0
    n_hours = min(MAX_HEATMAP_HOURS, max(HEATMAP_HOURS, int(longest_trip_h) + 2))
    hours = [floor_hour(dep_epoch) + k * HOUR for k in range(n_hours + 1)]
    # Keep checkpoints + cells within one weather request (1,000 locations) when possible,
    # so the heatmap arrives with the route scores instead of a minute later.
    cell_budget = max(MIN_CELLS, min(MAX_CELLS, WEATHER_REQUEST_MAX - checkpoint_points))
    cells = corridor([r.coords for r in result.routes], max_cells=cell_budget)
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
            "pts": [[round(lat, 3), round(lon, 3)] for lat, lon in points.coords],
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
            "legs": result.legs,
        },
        "warnings": result.warnings,
        "routes": {"type": "FeatureCollection", "features": route_features},
        "checkpoints": {"type": "FeatureCollection", "features": cp_features},
        "grid": {"type": "FeatureCollection", "features": grid_features},
        "checkpoint_points": checkpoint_points,
        "weather_points": [
            {"lat": lat, "lon": lon, "start": s, "end": e}
            for (lat, lon), (s, e) in zip(points.coords, points.ranges, strict=True)
        ],
    }


def _stop_json(st: rest_stops.Stop, schedule: rest_stops.Schedule, dep: int) -> dict[str, Any]:
    site = st.site
    return {
        "kind": st.kind,
        "lat": round(st.point[0], 5),
        "lon": round(st.point[1], 5),
        "mile": round(st.mile, 1),
        "at": round(dep + schedule.starts_at(st)),
        "duration_s": round(st.duration_s),
        "early_min": round(st.early_s / 60),
        "place": None
        if site is None
        else {
            "name": site.name
            or site.brand
            or ("Truck parking" if site.kind != "public" else "Rest area"),
            "kind": site.kind,
            "road": site.road,
            "spaces": site.spaces,
            "off_route_mi": round(st.off_route_mi, 1),
            "lat": site.lat,
            "lon": site.lon,
            "source": "U.S. DOT NTAD" if site.source == "ntad" else "OpenStreetMap",
        },
    }


def _stops_json(
    route: Route,
    schedule: rest_stops.Schedule | None,
    dep: int,
    req: PlanIn,
    via_miles: list[float],
) -> list[dict[str, Any]]:
    """Required rest stops and the user's own stops, in driving order."""
    out = [_stop_json(st, schedule, dep) for st in schedule.stops] if schedule else []
    for place, mile in zip(req.via, via_miles, strict=True):
        drive_s = cp.drive_seconds_at(route, mile)
        at = dep + (schedule.elapsed(drive_s) if schedule else drive_s)
        out.append(
            {
                "kind": "via",
                "lat": round(place.lat, 5),
                "lon": round(place.lon, 5),
                "mile": round(mile, 1),
                "at": round(at),
                "duration_s": 0,
                "early_min": 0,
                "place": {
                    "name": place.label or f"{place.lat:.4f}, {place.lon:.4f}",
                    "kind": "stop",
                    "road": None,
                    "spaces": None,
                    "off_route_mi": 0,
                    "lat": place.lat,
                    "lon": place.lon,
                    "source": "user",
                },
            }
        )
    return sorted(out, key=lambda s: (s["mile"], s["kind"] != "via"))


def _level_char(level: int | None) -> str:
    return "u" if level is None else str(level)


def _is_empty(pw: Any) -> bool:
    return all(v is None for arr in (pw.wind, pw.gust, pw.rain, pw.showers, pw.snow) for v in arr)


async def _fill_missing(req: ScoreIn, tok: dict[str, Any]) -> tuple[int, bool, str]:
    """Fetch, from this server, every point the browser could not download.

    Returns how many points were filled and whether the fetch succeeded.
    """
    missing = [i for i, pw in enumerate(req.weather) if _is_empty(pw)]
    if not missing:
        return 0, True, ""
    ranges = tok["wp"]
    pts = [tuple(tok["pts"][i]) for i in missing]
    try:
        series = await openmeteo.fetch(pts, max(ranges[i][1] for i in missing))
    except openmeteo.WeatherUnavailable as exc:
        return 0, False, str(exc)
    for i, h in zip(missing, series, strict=True):
        filled = openmeteo.window(h, ranges[i][0], ranges[i][1])
        req.weather[i] = PointWeather(**filled)
    return len(missing), True, ""


async def score(req: ScoreIn) -> dict[str, Any]:
    try:
        tok = signing.loads(req.token, salt=TOKEN_SALT, max_age=TOKEN_MAX_AGE_S)
    except signing.SignatureExpired as exc:
        raise PlanError("plan_expired", "This plan is over 2 hours old; plan again") from exc
    except signing.BadSignature as exc:
        raise PlanError("bad_token", "Plan token is invalid") from exc

    ranges: list[list[int]] = tok["wp"]
    if len(req.weather) != len(ranges):
        raise PlanError("weather_mismatch", "Weather must have one entry per weather point")
    filled, server_ok, server_error = 0, True, ""
    if req.fetch_missing:
        filled, server_ok, server_error = await _fill_missing(req, tok)
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
        "server_filled": filled,
        "server_weather_ok": server_ok,
        "server_weather_error": server_error,
        "conditions": [
            {"wind": s.wind_mph, "gust": s.gust_mph, "rain": s.rain_in_hr, "snow": s.snow_in_hr}
            for s in samples
        ],
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
        heatmap: list[str] = []
        for k in range(n_hours):
            hour_end = hour0 + k * HOUR
            # One byte per cell: severity index x 50 (0-200), or 255 when unknown.
            values = bytes(
                255 if v is None else round(v * 50)
                for v in (point_index(sample_hour(s, hour_end), cargo, mode) for s in cell_series)
            )
            heatmap.append(base64.b64encode(values).decode())
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
