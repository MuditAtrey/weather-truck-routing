"""Scoring routes and choosing the one to recommend.

The brief's preference order is:
    1. fewest Severe miles  2. fewest High miles  3. lowest average risk  4. shortest time
No Travel is worse than Severe, so No Travel miles are compared first. A route with any
No Travel miles is never recommended.

Missing forecasts are never silently treated as calm. Unknown miles are ranked twice,
once as Low and once as No Travel; a route is recommended only if it wins both ways.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from .forecast import Sample
from .risk import Conditions, Level, assess

WindMode = Literal["sustained", "gust"]

CRITERIA = ("no_travel_mi", "severe_mi", "high_mi", "avg_risk", "trip_min")
CRITERION_TEXT = {
    "no_travel_mi": "No Travel miles",
    "severe_mi": "Severe miles",
    "high_mi": "High miles",
    "avg_risk": "Average risk",
    "trip_min": "Travel time",
}


@dataclass(frozen=True, slots=True)
class PointRisk:
    level: Level | None  # None: forecast missing
    driver: str | None
    wind_mph: float | None
    rain_in_hr: float | None
    snow_in_hr: float | None


def point_risk(sample: Sample, cargo_lb: int, mode: WindMode) -> PointRisk:
    wind = sample.wind_mph if mode == "sustained" else sample.gust_mph
    if wind is None or sample.rain_in_hr is None or sample.snow_in_hr is None:
        return PointRisk(None, None, wind, sample.rain_in_hr, sample.snow_in_hr)
    a = assess(Conditions(wind, sample.rain_in_hr, sample.snow_in_hr), cargo_lb)
    return PointRisk(a.level, a.driver, wind, sample.rain_in_hr, sample.snow_in_hr)


@dataclass(frozen=True, slots=True)
class RouteSummary:
    route_id: int
    miles_by_level: tuple[float, float, float, float, float]  # Low..No Travel
    unknown_mi: float
    total_mi: float
    trip_s: float

    @property
    def known_mi(self) -> float:
        return self.total_mi - self.unknown_mi

    @property
    def avg_risk(self) -> float | None:
        """Distance-weighted mean of Low=0 .. No Travel=4 over miles with a forecast."""
        if self.known_mi <= 0:
            return None
        return sum(i * m for i, m in enumerate(self.miles_by_level)) / self.known_mi

    @property
    def worst(self) -> Level | None:
        for lvl in reversed(Level):
            if self.miles_by_level[lvl] > 0:
                return lvl
        return None

    def key(self, unknown_as: Level) -> tuple[float, float, float, float, float]:
        """Sort key, rounded so float noise never decides a ranking."""
        miles = list(self.miles_by_level)
        miles[unknown_as] += self.unknown_mi
        avg = sum(i * m for i, m in enumerate(miles)) / self.total_mi if self.total_mi else 0
        return (
            round(miles[Level.NO_TRAVEL], 1),
            round(miles[Level.SEVERE], 1),
            round(miles[Level.HIGH], 1),
            round(avg, 3),
            round(self.trip_s / 60),
        )


def summarize(
    route_id: int, risks: Sequence[PointRisk], represented_mi: Sequence[float], trip_s: float
) -> RouteSummary:
    by_level = [0.0] * 5
    unknown = 0.0
    for r, mi in zip(risks, represented_mi, strict=True):
        if r.level is None:
            unknown += mi
        else:
            by_level[r.level] += mi
    return RouteSummary(
        route_id=route_id,
        miles_by_level=(by_level[0], by_level[1], by_level[2], by_level[3], by_level[4]),
        unknown_mi=unknown,
        total_mi=sum(represented_mi),
        trip_s=trip_s,
    )


@dataclass(frozen=True, slots=True)
class Ranking:
    order: list[int]  # route ids, best first (unknown weather counted as No Travel)
    recommended: int | None
    status: Literal["ok", "all_no_travel", "weather_incomplete", "no_weather"]
    reasons: dict[int, str]  # one sentence per route


def _fmt(criterion: str, value: float) -> str:
    if criterion == "avg_risk":
        return f"{value:.2f}"
    if criterion == "trip_min":
        h, m = divmod(int(value), 60)
        return f"{h} h {m:02d} min"
    return f"{value:g} mi"


def _compare(
    winner: RouteSummary, other: RouteSummary, unknown_as: Level
) -> tuple[str, float, float] | None:
    for name, w, o in zip(CRITERIA, winner.key(unknown_as), other.key(unknown_as), strict=True):
        if w != o:
            return name, w, o
    return None


def rank(summaries: Sequence[RouteSummary]) -> Ranking:
    if not summaries:
        return Ranking([], None, "no_weather", {})
    pessimistic = sorted(summaries, key=lambda s: (s.key(Level.NO_TRAVEL), s.route_id))
    optimistic = sorted(summaries, key=lambda s: (s.key(Level.LOW), s.route_id))
    order = [s.route_id for s in pessimistic]
    best = pessimistic[0]
    names = {s.route_id: f"Route {chr(65 + s.route_id)}" for s in summaries}
    reasons: dict[int, str] = {}

    for s in pessimistic[1:]:
        diff = _compare(best, s, Level.NO_TRAVEL)
        if diff is None:
            reasons[s.route_id] = f"Ties with {names[best.route_id]} on every criterion."
        else:
            name, w, o = diff
            reasons[s.route_id] = (
                f"{CRITERION_TEXT[name]}: {_fmt(name, o)} vs {_fmt(name, w)} "
                f"on {names[best.route_id]}."
            )

    if all(s.known_mi <= 0 for s in summaries):
        status: Literal["ok", "all_no_travel", "weather_incomplete", "no_weather"] = "no_weather"
        recommended = None
    elif optimistic[0].route_id != best.route_id:
        status, recommended = "weather_incomplete", None
    elif best.miles_by_level[Level.NO_TRAVEL] > 0:
        status, recommended = "all_no_travel", None
    else:
        status, recommended = "ok", best.route_id

    if len(pessimistic) > 1:
        diff = _compare(best, pessimistic[1], Level.NO_TRAVEL)
        runner = names[pessimistic[1].route_id]
        if diff is None:
            reasons[best.route_id] = f"Ties with {runner} on every criterion; listed first."
        else:
            name, w, o = diff
            reasons[best.route_id] = (
                f"{CRITERION_TEXT[name]}: {_fmt(name, w)} vs {_fmt(name, o)} on {runner}"
                f"{'; equal on all weather criteria' if name == 'trip_min' else ''}."
            )
    else:
        reasons[best.route_id] = "Only route available."
    return Ranking(order, recommended, status, reasons)
