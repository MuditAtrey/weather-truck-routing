"""Request and response shapes. These generate the OpenAPI spec and the frontend types."""

from typing import Any, Literal

from ninja import Schema
from pydantic import ConfigDict, Field


class Place(Schema):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    label: str = Field(default="", max_length=200)


class PlanIn(Schema):
    model_config = ConfigDict(allow_inf_nan=False)

    origin: Place
    destination: Place
    departure_local: str = Field(
        description="Departure as wall-clock time at the origin, YYYY-MM-DDTHH:MM",
        pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$",
    )
    cargo_lb: int = Field(ge=0, le=80_000, description="Cargo weight in pounds")
    interval_mi: Literal[10, 25, 50] = 25
    hos: bool = Field(default=True, description="Add US hours-of-service breaks to ETAs")


class WeatherPoint(Schema):
    lat: float
    lon: float
    start: int = Field(description="First hour needed (epoch seconds, on the hour)")
    end: int = Field(description="Last hour needed (epoch seconds, on the hour)")


class RouterInfo(Schema):
    provider: Literal["valhalla", "osrm"]
    profile: Literal["truck", "car_capped"]
    fallback_reason: str | None
    legs: int = Field(default=1, description="Valhalla requests stitched into each route")


class PlanOut(Schema):
    token: str
    timezone: str
    departure: int
    hours: list[int] = Field(description="Heatmap hours (epoch seconds), departure hour + 0..48")
    router: RouterInfo
    warnings: list[str]
    routes: dict[str, Any] = Field(description="GeoJSON FeatureCollection of LineStrings")
    checkpoints: dict[str, Any] = Field(description="GeoJSON FeatureCollection of Points")
    grid: dict[str, Any] = Field(description="GeoJSON FeatureCollection of Polygons")
    checkpoint_points: int = Field(
        description="The first N weather points are checkpoints; the rest are heatmap cells"
    )
    weather_points: list[WeatherPoint]


class PointWeather(Schema):
    model_config = ConfigDict(allow_inf_nan=False)

    wind: list[float | None] = Field(max_length=200)
    gust: list[float | None] = Field(max_length=200)
    rain: list[float | None] = Field(max_length=200)
    showers: list[float | None] = Field(max_length=200)
    snow: list[float | None] = Field(max_length=200)


class ScoreIn(Schema):
    token: str = Field(max_length=300_000)
    weather: list[PointWeather] = Field(max_length=2_000)
    fetch_missing: bool = Field(
        default=False,
        description="Download, from the server, points the browser sent with no data at all",
    )


class RouteScore(Schema):
    id: int
    miles_by_level: list[float]
    unknown_mi: float
    avg_risk: float | None
    worst: int | None


class RankingOut(Schema):
    order: list[int]
    recommended: int | None
    status: Literal["ok", "all_no_travel", "weather_incomplete", "no_weather"]
    reasons: dict[int, str]


class ModeResult(Schema):
    checkpoint_levels: str = Field(description="One char per checkpoint: 0-4, or u if unknown")
    checkpoint_drivers: str = Field(description="w(ind), r(ain), s(now), or - per checkpoint")
    routes: list[RouteScore]
    ranking: RankingOut
    heatmap: list[str] = Field(
        description="Per hour, base64 bytes, one per grid cell: severity x 50 (0-200), 255 unknown"
    )


class CheckpointWeather(Schema):
    wind: float | None
    gust: float | None
    rain: float | None
    snow: float | None


class ScoreOut(Schema):
    server_filled: int = Field(description="Points the server downloaded itself")
    server_weather_ok: bool
    server_weather_error: str = Field(
        default="", description="Why the server could not fetch, if it failed"
    )
    conditions: list[CheckpointWeather]
    sustained: ModeResult
    gust: ModeResult


class TimezoneOut(Schema):
    timezone: str


class ErrorOut(Schema):
    code: str
    detail: str
