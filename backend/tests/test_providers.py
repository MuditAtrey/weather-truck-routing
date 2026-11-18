import asyncio

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
async def test_long_trip_skips_valhalla_entirely() -> None:
    v = respx.post(V_URL)
    respx.get(url__startswith=O_URL).mock(
        return_value=httpx.Response(200, json=load("osrm_chi_sfo.json"))
    )
    result = await router.find_routes(CHICAGO, SAN_FRANCISCO, 30_000)
    assert v.call_count == 0
    assert result.provider == "osrm" and result.fallback_reason == "distance_cap"


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
async def test_valhalla_154_falls_back_with_distance_reason() -> None:
    respx.post(V_URL).mock(return_value=httpx.Response(400, json=load("valhalla_154.json")))
    respx.get(url__startswith=O_URL).mock(
        return_value=httpx.Response(200, json=load("osrm_dal_den.json"))
    )
    result = await router.find_routes(DALLAS, DENVER, 30_000)
    assert result.fallback_reason == "distance_cap"


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
