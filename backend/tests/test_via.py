"""Trips through the user's own stops: A to B to C, routed leg by leg."""

import itertools
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from ninja.testing import TestAsyncClient

from planner.api import api
from planner.domain.route import Route, from_segment_durations, join
from planner.providers import router
from planner.providers.router import RoutingResult

aclient = TestAsyncClient(api)
MI_LAT = 1 / 69.0934  # degrees of latitude per mile


def line(points: list[tuple[float, float]], mph: float = 60.0, source: str = "valhalla") -> Route:
    """A route through `points`, one vertex per mile along each straight piece."""
    coords: list[tuple[float, float]] = [points[0]]
    for (a_lat, a_lon), (b_lat, b_lon) in itertools.pairwise(points):
        n = max(1, round(abs(b_lat - a_lat) / MI_LAT + abs(b_lon - a_lon) / MI_LAT))
        coords += [
            (a_lat + (b_lat - a_lat) * k / n, a_lon + (b_lon - a_lon) * k / n)
            for k in range(1, n + 1)
        ]
    segs = [3600 / mph] * (len(coords) - 1)
    return from_segment_durations(coords, segs, sum(segs), source=source)


A, B, C = (35.0, -100.0), (36.0, -100.0), (37.0, -100.0)


def fake_find_routes(options: dict[tuple[tuple[float, float], tuple[float, float]], list[Route]]):
    async def find_routes(
        origin: tuple[float, float], dest: tuple[float, float], cargo_lb: int
    ) -> RoutingResult:
        return RoutingResult(options[(origin, dest)], "valhalla")

    return find_routes


async def test_each_leg_is_routed_and_option_k_uses_each_legs_option_k(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    leg1 = [line([A, B]), line([A, (35.5, -99.8), B]), line([A, (35.5, -100.3), B])]
    leg2 = [line([B, C])]  # this leg has only one road
    monkeypatch.setattr(router, "find_routes", fake_find_routes({(A, B): leg1, (B, C): leg2}))
    trip = await router.find_trip([A, B, C], 30_000)
    routes = trip.routing.routes
    assert len(routes) == 3
    for k, r in enumerate(routes):
        assert r.distance_mi == pytest.approx(leg1[k].distance_mi + leg2[0].distance_mi, rel=1e-6)
        assert trip.stop_miles[k] == [pytest.approx(leg1[k].distance_mi)]
        assert B in r.coords  # the truck really goes to the stop
    assert "fewer_than_3_routes" not in trip.routing.warnings


async def test_identical_combinations_are_not_offered_twice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        router, "find_routes", fake_find_routes({(A, B): [line([A, B])], (B, C): [line([B, C])]})
    )
    trip = await router.find_trip([A, B, C], 30_000)
    assert len(trip.routing.routes) == 1
    assert "fewer_than_3_routes" in trip.routing.warnings


async def test_one_car_routed_leg_marks_the_trip_as_car_routed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def find_routes(origin: Any, dest: Any, cargo_lb: int) -> RoutingResult:
        if origin == A:
            return RoutingResult([line([A, B])], "valhalla")
        return RoutingResult([line([B, C], source="osrm")], "osrm", "valhalla_slow")

    monkeypatch.setattr(router, "find_routes", find_routes)
    trip = await router.find_trip([A, B, C], 30_000)
    assert trip.routing.provider == "osrm"
    assert trip.routing.fallback_reason == "valhalla_slow"
    assert trip.routing.routes[0].source == "osrm"


def test_join_keeps_a_detour_to_the_users_stop() -> None:
    # The stop is down a side road: the truck drives 5 miles out to it and back.
    out = line([A, (35.3, -100.0), (35.3, -99.9)])
    back = line([(35.3, -99.9), (35.3, -100.0), (35.6, -100.0)])
    kept = join([out, back], "valhalla", cut_spurs=False)
    assert kept.distance_mi == pytest.approx(out.distance_mi + back.distance_mi, rel=1e-6)
    assert (35.3, -99.9) in kept.coords
    cut = join([out, back], "valhalla")  # for joins we chose ourselves, the spur goes
    assert cut.distance_mi < kept.distance_mi - 8


def _body(**over: Any) -> dict[str, Any]:
    dep = (datetime.now(UTC) + timedelta(hours=3)).astimezone(ZoneInfo("America/Chicago"))
    b: dict[str, Any] = {
        "origin": {"lat": A[0], "lon": A[1], "label": "Start"},
        "destination": {"lat": C[0], "lon": C[1], "label": "End"},
        "via": [{"lat": B[0], "lon": B[1], "label": "Middle, KS"}],
        "departure_local": dep.strftime("%Y-%m-%dT%H:%M"),
        "cargo_lb": 30_000,
    }
    b.update(over)
    return b


async def test_plan_lists_the_users_stop_in_driving_order(monkeypatch: pytest.MonkeyPatch) -> None:
    # Long enough legs (11+ hours in total) that a required break also appears.
    far_c = (35.0 + 700 * MI_LAT, -100.0)
    mid = (35.0 + 300 * MI_LAT, -100.0)
    monkeypatch.setattr(
        router,
        "find_routes",
        fake_find_routes({(A, mid): [line([A, mid])], (mid, far_c): [line([mid, far_c])]}),
    )
    r = await aclient.post(
        "/plan",
        json=_body(
            destination={"lat": far_c[0], "lon": far_c[1], "label": "End"},
            via=[{"lat": mid[0], "lon": mid[1], "label": "Middle, KS"}],
        ),
    )
    assert r.status_code == 200, r.json()
    stops = r.json()["routes"]["features"][0]["properties"]["stops"]
    via = [s for s in stops if s["kind"] == "via"]
    assert len(via) == 1
    assert via[0]["place"]["name"] == "Middle, KS"
    assert via[0]["mile"] == pytest.approx(300, abs=1)
    assert [s["mile"] for s in stops] == sorted(s["mile"] for s in stops)
    assert [s["at"] for s in stops] == sorted(s["at"] for s in stops)
    assert any(s["kind"] == "break" for s in stops)
    # Five hours of driving at 60 mph, no rest yet: arrival is departure + 5 h.
    plan = r.json()
    assert via[0]["at"] - plan["departure"] == pytest.approx(5 * 3600, abs=120)


async def test_too_many_stops_or_repeated_places_are_rejected() -> None:
    four = [{"lat": 35.5 + i * 0.1, "lon": -100.0} for i in range(4)]
    assert (await aclient.post("/plan", json=_body(via=four))).status_code == 422
    same = await aclient.post("/plan", json=_body(via=[{"lat": A[0], "lon": A[1]}]))
    assert same.status_code == 422 and same.json()["code"] == "same_place"
