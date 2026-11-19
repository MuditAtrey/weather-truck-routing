import asyncio
import json

import httpx
import pytest
import respx

from planner.providers import router, valhalla
from planner.providers.errors import RoutingError

from .conftest import load

DALLAS = (32.7767, -96.797)
DENVER = (39.7392, -104.9903)
CHICAGO = (41.8781, -87.6298)
SAN_FRANCISCO = (37.7749, -122.4194)
V_URL = "https://valhalla1.openstreetmap.de/route"
O_URL = "https://router.project-osrm.org/route/v1/driving/"


def _encode(coords: list[tuple[float, float]]) -> str:
    out, prev = [], (0, 0)
    for lat, lon in coords:
        cur = (round(lat * 1e6), round(lon * 1e6))
        for d in (cur[0] - prev[0], cur[1] - prev[1]):
            v = ~(d << 1) if d < 0 else d << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev = cur
    return "".join(out)


def straight_trip(a: tuple[float, float], b: tuple[float, float]) -> dict[str, object]:
    """A fake Valhalla answer: a straight 60 mph road from a to b."""
    n = 50
    coords = [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n + 1)]
    from planner.domain.geo import haversine_mi

    miles = haversine_mi(a, b)
    return {
        "trip": {
            "legs": [
                {
                    "shape": _encode(coords),
                    "maneuvers": [
                        {"begin_shape_index": 0, "end_shape_index": n, "time": miles / 60 * 3600}
                    ],
                }
            ],
            "summary": {"time": miles / 60 * 3600, "length": miles},
        }
    }


def test_fake_trip_round_trips_through_the_parser() -> None:
    r = valhalla.parse(straight_trip(DALLAS, DENVER))[0]
    assert r.coords[0] == pytest.approx(DALLAS, abs=1e-5)
    assert r.coords[-1] == pytest.approx(DENVER, abs=1e-5)


def test_valhalla_parse_gives_three_routes_with_full_timing() -> None:
    routes = valhalla.parse(load("valhalla_dal_den.json"))
    assert len(routes) == 3
    for r in routes:
        assert r.coords[0][0] == pytest.approx(32.77, abs=0.05)
        assert len(r.cum_drive_s) == len(r.coords)
        assert all(b >= a for a, b in zip(r.cum_drive_s, r.cum_drive_s[1:], strict=False))
    summary = load("valhalla_dal_den.json")["trip"]["summary"]
    assert routes[0].drive_s == pytest.approx(summary["time"], rel=1e-6)
    assert routes[0].distance_mi == pytest.approx(summary["length"], rel=0.01)


def test_valhalla_weight_clamp_warning_is_an_error() -> None:
    with pytest.raises(RoutingError) as e:
        valhalla.parse(load("valhalla_clamped.json"))
    assert e.value.kind == "bad_input"


def test_gross_weight_in_tonnes() -> None:
    assert valhalla.gross_tonnes(46_000) == pytest.approx(36.287, abs=1e-3)  # 80,000 lb gross


@respx.mock
async def test_short_trip_uses_valhalla_truck() -> None:
    respx.post(V_URL).mock(return_value=httpx.Response(200, json=load("valhalla_dal_den.json")))
    result = await router.find_routes(DALLAS, DENVER, 30_000)
    assert result.provider == "valhalla" and result.fallback_reason is None
    assert len(result.routes) == 3


@respx.mock
async def test_valhalla_down_falls_back_to_osrm() -> None:
    respx.post(V_URL).mock(side_effect=httpx.ConnectError("refused"))
    respx.get(url__startswith=O_URL).mock(
        return_value=httpx.Response(200, json=load("osrm_dal_den.json"))
    )
    result = await router.find_routes(DALLAS, DENVER, 30_000)
    assert result.provider == "osrm" and result.fallback_reason == "valhalla_unavailable"
    assert len(result.routes) >= 2


@respx.mock
async def test_valhalla_154_switches_to_truck_legs() -> None:
    # Over the cap in one piece; each shorter leg is accepted.
    v = respx.post(V_URL).mock(
        side_effect=[httpx.Response(400, json=load("valhalla_154.json"))]
        + [httpx.Response(200, json=load("valhalla_dal_den.json"))] * 20
    )
    respx.get(url__startswith=O_URL).mock(
        return_value=httpx.Response(200, json=load("osrm_dal_den.json"))
    )
    result = await router.find_routes(DALLAS, DENVER, 30_000)
    assert result.provider == "valhalla" and result.fallback_reason is None
    assert result.legs == 2 and v.call_count > 1


@respx.mock
async def test_long_trip_is_truck_routed_in_legs_with_headings() -> None:
    sent = []

    def valhalla_leg(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append(body)
        a, b = body["locations"]
        return httpx.Response(200, json=straight_trip((a["lat"], a["lon"]), (b["lat"], b["lon"])))

    respx.post(V_URL).mock(side_effect=valhalla_leg)
    respx.get(url__startswith=O_URL).mock(
        return_value=httpx.Response(200, json=load("osrm_chi_sfo.json"))
    )
    result = await router.find_routes(CHICAGO, SAN_FRANCISCO, 30_000)
    assert result.provider == "valhalla" and result.legs >= 3
    # Every leg is short enough for the server, and joins carry a direction of travel.
    for body in sent:
        a, b = body["locations"]
        assert router.straight_km([(a["lat"], a["lon"]), (b["lat"], b["lon"])]) < 1450
        assert body["alternates"] == 0
    assert any("heading" in body["locations"][0] for body in sent)
    assert "heading" not in sent[0]["locations"][0]  # the real origin has no forced heading


@respx.mock
async def test_failed_leg_keeps_osrm_routes() -> None:
    respx.post(V_URL).mock(return_value=httpx.Response(503))
    respx.get(url__startswith=O_URL).mock(
        return_value=httpx.Response(200, json=load("osrm_chi_sfo.json"))
    )
    result = await router.find_routes(CHICAGO, SAN_FRANCISCO, 30_000)
    assert result.provider == "osrm" and result.fallback_reason == "valhalla_legs_failed"


@respx.mock
async def test_no_road_path_is_final_not_a_fallback() -> None:
    respx.post(V_URL).mock(
        return_value=httpx.Response(400, json={"error_code": 442, "error": "No path"})
    )
    o = respx.get(url__startswith=O_URL)
    with pytest.raises(RoutingError) as e:
        await router.find_routes(DALLAS, DENVER, 30_000)
    assert e.value.kind == "no_route" and o.call_count == 0


@respx.mock
async def test_slow_valhalla_is_hedged_with_osrm(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(router, "HEDGE_AFTER_S", 0.05)

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1.0)
        return httpx.Response(200, json=load("valhalla_dal_den.json"))

    respx.post(V_URL).mock(side_effect=slow)
    respx.get(url__startswith=O_URL).mock(
        return_value=httpx.Response(200, json=load("osrm_dal_den.json"))
    )
    result = await router.find_routes(DALLAS, DENVER, 30_000)
    assert result.provider == "osrm" and result.fallback_reason == "valhalla_slow"


@respx.mock
async def test_missing_third_route_is_filled_through_a_side_point() -> None:
    data = load("valhalla_dal_den.json")
    # The server returns A and C; a detour then finds B, which shares little road with A.
    two = {"trip": data["trip"], "alternates": data["alternates"][1:]}
    respx.post(V_URL).mock(
        side_effect=[
            httpx.Response(200, json=two),
            httpx.Response(200, json={"trip": data["alternates"][0]["trip"]}),
        ]
    )
    result = await router.find_routes(DALLAS, DENVER, 30_000)
    assert len(result.routes) == 3
    assert result.routes[2].via is not None
    assert "fewer_than_3_routes" not in result.warnings


@respx.mock
async def test_routes_are_cached() -> None:
    v = respx.post(V_URL).mock(return_value=httpx.Response(200, json=load("valhalla_dal_den.json")))
    await router.find_routes(DALLAS, DENVER, 30_000)
    await router.find_routes(DALLAS, DENVER, 30_000)
    assert v.call_count == 1


@respx.mock
async def test_point_far_from_any_road_is_rejected() -> None:
    respx.post(V_URL).mock(return_value=httpx.Response(200, json=load("valhalla_dal_den.json")))
    lake = (32.0, -96.797)  # 55 miles south of where the fixture route starts
    with pytest.raises(RoutingError) as e:
        await router.find_routes(lake, DENVER, 30_000)
    assert e.value.kind == "not_on_road"


@respx.mock
async def test_no_single_valhalla_request_exceeds_the_cap() -> None:
    bodies = []

    def record(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(503)

    respx.post(V_URL).mock(side_effect=record)
    respx.get(url__startswith=O_URL).mock(
        return_value=httpx.Response(200, json=load("osrm_chi_sfo.json"))
    )
    await router.find_routes(CHICAGO, SAN_FRANCISCO, 30_000)
    for body in bodies:
        pts = [(loc["lat"], loc["lon"]) for loc in body["locations"]]
        assert router.straight_km(pts) < 1450
