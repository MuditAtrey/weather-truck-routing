from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pytest
import respx
from ninja.testing import TestAsyncClient, TestClient

from planner import services
from planner.api import api

from .conftest import load

V_URL = "https://valhalla1.openstreetmap.de/route"
client = TestClient(api)
aclient = TestAsyncClient(api)


def departure(hours_ahead: float = 2, tz: str = "America/Chicago") -> str:
    t = datetime.now(UTC) + timedelta(hours=hours_ahead)
    return t.astimezone(ZoneInfo(tz)).strftime("%Y-%m-%dT%H:%M")


def body(**over: Any) -> dict[str, Any]:
    b = {
        "origin": {"lat": 32.7767, "lon": -96.797, "label": "Dallas, TX"},
        "destination": {"lat": 39.7392, "lon": -104.9903, "label": "Denver, CO"},
        "departure_local": departure(),
        "cargo_lb": 30000,
        "interval_mi": 25,
        "hos": True,
    }
    b.update(over)
    return b


def test_health() -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_api_docs_page_renders() -> None:
    from django.test import Client

    r = Client().get("/api/docs")
    assert r.status_code == 200 and b"swagger" in r.content.lower()


def test_timezone_lookup() -> None:
    assert client.get("/timezone?lat=39.74&lon=-104.99").json() == {"timezone": "America/Denver"}


@pytest.mark.parametrize(
    "bad",
    [
        {"cargo_lb": -1},
        {"cargo_lb": 80_001},
        {"cargo_lb": 1.5},
        {"interval_mi": 30},
        {"departure_local": "tomorrow"},
        {"origin": {"lat": 91, "lon": 0}},
    ],
)
async def test_validation_errors_are_422(bad: dict[str, Any]) -> None:
    r = await aclient.post("/plan", json=body(**bad))
    assert r.status_code == 422


async def test_nan_weight_is_rejected() -> None:
    raw = '{"origin": {"lat": NaN, "lon": 0}, "cargo_lb": 1}'
    r = await aclient.post("/plan", data=raw, content_type="application/json")
    assert r.status_code in (400, 422)


async def test_same_place_is_rejected_before_routing() -> None:
    r = await aclient.post("/plan", json=body(destination={"lat": 32.7768, "lon": -96.7971}))
    assert r.status_code == 422 and r.json()["code"] == "same_place"


async def test_departure_window() -> None:
    past = await aclient.post("/plan", json=body(departure_local=departure(-3)))
    assert past.json()["code"] == "departure_past"
    far = await aclient.post("/plan", json=body(departure_local=departure(80)))
    assert far.json()["code"] == "departure_too_far"


def test_spring_forward_gap_does_not_exist() -> None:
    now = datetime(2027, 3, 13, 12, tzinfo=UTC)
    with pytest.raises(services.PlanError) as e:
        services.resolve_departure("2027-03-14T02:30", "America/Chicago", now)
    assert e.value.code == "departure_nonexistent"


@respx.mock
async def test_plan_then_score_round_trip() -> None:
    respx.post(V_URL).mock(return_value=httpx.Response(200, json=load("valhalla_dal_den.json")))
    r = await aclient.post("/plan", json=body())
    assert r.status_code == 200, r.json()
    plan = r.json()
    assert plan["router"] == {
        "provider": "valhalla",
        "profile": "truck",
        "fallback_reason": None,
        "legs": 1,
    }
    assert len(plan["routes"]["features"]) == 3
    assert len(plan["hours"]) == 49
    assert all(f["id"] >= 1 for f in plan["grid"]["features"])
    first = plan["routes"]["features"][0]["geometry"]["coordinates"][0]
    assert -97.5 < first[0] < -96 and 32 < first[1] < 33.5  # GeoJSON is [lon, lat]

    # Calm everywhere, except 60 mph gusts at every point.
    weather = []
    for wp in plan["weather_points"]:
        n = (wp["end"] - wp["start"]) // 3600 + 1
        weather.append(
            {
                "wind": [10.0] * n,
                "gust": [60.0] * n,
                "rain": [0.0] * n,
                "showers": [0.0] * n,
                "snow": [0.0] * n,
            }
        )
    s = await aclient.post("/score", json={"token": plan["token"], "weather": weather})
    assert s.status_code == 200, s.json()
    out = s.json()
    n_cp = len(plan["checkpoints"]["features"])
    assert out["sustained"]["checkpoint_levels"] == "0" * n_cp
    assert out["sustained"]["ranking"]["status"] == "ok"
    assert out["gust"]["checkpoint_levels"] == "4" * n_cp
    assert out["gust"]["ranking"]["recommended"] is None
    assert out["gust"]["ranking"]["status"] == "all_no_travel"
    assert len(out["gust"]["heatmap"]) == 49
    import base64

    assert set(base64.b64decode(out["gust"]["heatmap"][0])) == {200}  # No Travel everywhere
    assert set(base64.b64decode(out["sustained"]["heatmap"][0])) == {20}  # 10 mph: 0.4 into Low

    # Missing forecasts are unknown, never calm.
    for w in weather:
        w["wind"] = [None] * len(w["wind"])
    s2 = (await aclient.post("/score", json={"token": plan["token"], "weather": weather})).json()
    assert set(s2["sustained"]["checkpoint_levels"]) == {"u"}
    assert s2["sustained"]["ranking"]["status"] == "no_weather"


async def test_score_rejects_tampered_token_and_bad_shapes() -> None:
    r = await aclient.post("/score", json={"token": "abc", "weather": []})
    assert r.status_code == 422 and r.json()["code"] == "bad_token"
    token = services.signing.dumps(
        {
            "cargo": 0,
            "routes": [],
            "cps": [],
            "cells": [],
            "hours": [0, 1],
            "wp": [[0, 3600]],
            "pts": [[40.0, -100.0]],
        },
        salt=services.TOKEN_SALT,
        compress=True,
    )
    short = {"wind": [1.0], "gust": [1.0], "rain": [0.0], "showers": [0.0], "snow": [0.0]}
    r = await aclient.post("/score", json={"token": token, "weather": [short]})
    assert r.json()["code"] == "weather_mismatch"
    wild = {k: [999.0, 999.0] for k in short}
    r = await aclient.post("/score", json={"token": token, "weather": [wild]})
    assert r.json()["code"] == "weather_out_of_range"


@respx.mock
async def test_upstream_failure_is_a_clean_502() -> None:
    respx.post(V_URL).mock(return_value=httpx.Response(503, text="<html>down</html>"))
    respx.get(url__startswith="https://router.project-osrm.org").mock(
        return_value=httpx.Response(503, text="down")
    )
    r = await aclient.post("/plan", json=body())
    assert r.status_code == 502
    assert r.json() == {
        "code": "unavailable",
        "detail": "The routing services are not responding. Try again in a minute.",
    }


@respx.mock
async def test_server_fills_points_the_browser_could_not_download() -> None:
    respx.post(V_URL).mock(return_value=httpx.Response(200, json=load("valhalla_dal_den.json")))
    plan = (await aclient.post("/plan", json=body())).json()
    wps = plan["weather_points"]

    def open_meteo(request: httpx.Request) -> httpx.Response:
        n = len(request.content.decode().split("latitude=")[1].split("&")[0].split("%2C"))
        start = min(w["start"] for w in wps)
        hours = 400
        hourly = {"time": [start + 3600 * k for k in range(hours)]}
        for v in ("wind_speed_10m", "wind_gusts_10m", "rain", "showers", "snowfall"):
            hourly[v] = [50.0 if v == "wind_speed_10m" else 0.0] * hours
        return httpx.Response(200, json=[{"hourly": hourly}] * n)

    om = respx.post("https://api.open-meteo.com/v1/forecast").mock(side_effect=open_meteo)
    empty = []
    for wp in wps:
        n = (wp["end"] - wp["start"]) // 3600 + 1
        empty.append({k: [None] * n for k in ("wind", "gust", "rain", "showers", "snow")})
    r = await aclient.post(
        "/score", json={"token": plan["token"], "weather": empty, "fetch_missing": True}
    )
    out = r.json()
    assert om.called and out["server_filled"] == len(wps) and out["server_weather_ok"]
    assert set(out["sustained"]["checkpoint_levels"]) == {"3"}  # 50 mph sustained: Severe


@respx.mock
async def test_server_fallback_failure_is_reported_not_hidden() -> None:
    respx.post(V_URL).mock(return_value=httpx.Response(200, json=load("valhalla_dal_den.json")))
    plan = (await aclient.post("/plan", json=body())).json()
    respx.post("https://api.open-meteo.com/v1/forecast").mock(return_value=httpx.Response(429))
    empty = [
        {
            k: [None] * ((wp["end"] - wp["start"]) // 3600 + 1)
            for k in ("wind", "gust", "rain", "showers", "snow")
        }
        for wp in plan["weather_points"]
    ]
    out = (
        await aclient.post(
            "/score", json={"token": plan["token"], "weather": empty, "fetch_missing": True}
        )
    ).json()
    assert out["server_weather_ok"] is False
    assert out["sustained"]["ranking"]["status"] == "no_weather"


@respx.mock
async def test_heatmap_hours_cover_the_whole_trip() -> None:
    respx.post(V_URL).mock(return_value=httpx.Response(200, json=load("valhalla_dal_den.json")))
    plan = (await aclient.post("/plan", json=body())).json()
    longest = max(f["properties"]["trip_s"] for f in plan["routes"]["features"])
    assert len(plan["hours"]) - 1 >= max(48, longest / 3600)


@respx.mock
async def test_server_fallback_waits_out_a_per_minute_limit(monkeypatch) -> None:
    from planner.providers import openmeteo

    monkeypatch.setattr(openmeteo, "MAX_WAIT_S", 0.01)
    respx.post(V_URL).mock(return_value=httpx.Response(200, json=load("valhalla_dal_den.json")))
    plan = (await aclient.post("/plan", json=body())).json()
    start = min(w["start"] for w in plan["weather_points"])
    hourly = {"time": [start + 3600 * k for k in range(400)]}
    for v in ("wind_speed_10m", "wind_gusts_10m", "rain", "showers", "snowfall"):
        hourly[v] = [5.0] * 400

    def reply(request: httpx.Request) -> httpx.Response:
        n = len(request.content.decode().split("latitude=")[1].split("&")[0].split("%2C"))
        return httpx.Response(200, json=[{"hourly": hourly}] * n)

    om = respx.post("https://api.open-meteo.com/v1/forecast").mock(
        side_effect=[
            httpx.Response(429, json={"reason": "Minutely API request limit exceeded"}),
            reply,
        ]
    )
    empty = [
        {
            k: [None] * ((w["end"] - w["start"]) // 3600 + 1)
            for k in ("wind", "gust", "rain", "showers", "snow")
        }
        for w in plan["weather_points"]
    ]
    out = (
        await aclient.post(
            "/score", json={"token": plan["token"], "weather": empty, "fetch_missing": True}
        )
    ).json()
    assert om.call_count == 2 and out["server_weather_ok"] is True
