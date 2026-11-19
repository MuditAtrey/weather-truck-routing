import pytest
from hypothesis import given
from hypothesis import strategies as st

from planner.domain.risk import (
    Conditions,
    Level,
    assess,
    load_adjusted_wind_level,
    rain_level,
    severity_index,
    snow_level,
    wind_level,
)

L, M, H, S, N = Level.LOW, Level.MODERATE, Level.HIGH, Level.SEVERE, Level.NO_TRAVEL


@pytest.mark.parametrize(
    ("mph", "level"),
    [
        (0, L),
        (24.9, L),
        (25.0, M),
        (34.0, M),
        (34.9, M),
        (35.0, H),
        (44.9, H),
        (45.0, S),
        (54.9, S),
        (55.0, N),
        (80.0, N),
    ],
)
def test_wind_bands(mph: float, level: Level) -> None:
    assert wind_level(mph) == level


@pytest.mark.parametrize(
    ("in_hr", "level"),
    [
        (0, L),
        (0.099, L),
        (0.10, M),
        (0.249, M),
        (0.25, H),
        (0.499, H),
        (0.50, S),
        (0.999, S),
        (1.00, S),
        (1.001, N),
        (2.0, N),
    ],
)
def test_rain_bands_top_band_is_strict(in_hr: float, level: Level) -> None:
    assert rain_level(in_hr) == level


@pytest.mark.parametrize(
    ("in_hr", "level"),
    [(0, L), (0.49, L), (0.5, M), (0.99, M), (1.0, H), (1.99, H), (2.0, S), (3.0, S), (3.01, N)],
)
def test_snow_bands_top_band_is_strict(in_hr: float, level: Level) -> None:
    assert snow_level(in_hr) == level


def test_float_noise_does_not_move_a_band() -> None:
    assert 0.09 + 0.01 < 0.10  # the trap
    assert rain_level(0.09 + 0.01) == M


@pytest.mark.parametrize(
    ("mph", "cargo", "level"),
    [
        (55.0, 0, N),  # >= 55 is No Travel for any load
        (45.0, 30_000, S),  # 45-54 needs MORE than 30,000 lb
        (45.0, 30_001, N),
        (54.9, 30_001, N),
        (44.9, 30_001, H),
        (35.0, 40_000, H),  # 35-44 needs MORE than 40,000 lb
        (35.0, 40_001, S),
        (44.9, 40_001, S),
        (34.9, 80_000, M),  # below 35 the load does not matter
        (45.0, 40_001, N),  # the stronger rule wins in its own band
    ],
)
def test_load_rules(mph: float, cargo: int, level: Level) -> None:
    assert load_adjusted_wind_level(mph, cargo) == level


def test_overall_level_is_worst_condition() -> None:
    a = assess(Conditions(wind_mph=20, rain_in_hr=0.3, snow_in_hr=1.5), cargo_lb=10_000)
    assert (a.wind, a.rain, a.snow, a.level) == (L, H, H, H)
    assert a.driver == "snow"  # ties report snow before rain


@given(
    st.floats(0, 120, allow_nan=False),
    st.floats(0, 3, allow_nan=False),
    st.floats(0, 5, allow_nan=False),
    st.integers(0, 80_000),
)
def test_more_weather_or_load_never_lowers_risk(
    wind: float, rain: float, snow: float, cargo: int
) -> None:
    base = assess(Conditions(wind, rain, snow), cargo).level
    assert assess(Conditions(wind + 1, rain, snow), cargo).level >= base
    assert assess(Conditions(wind, rain + 0.05, snow), cargo).level >= base
    assert assess(Conditions(wind, rain, snow + 0.1), cargo).level >= base
    assert assess(Conditions(wind, rain, snow), min(80_000, cargo + 5_000)).level >= base


@given(
    st.floats(0, 120, allow_nan=False),
    st.floats(0, 3, allow_nan=False),
    st.floats(0, 5, allow_nan=False),
    st.integers(0, 80_000),
)
def test_severity_index_never_disagrees_with_the_level(
    wind: float, rain: float, snow: float, cargo: int
) -> None:
    c = Conditions(wind, rain, snow)
    idx = severity_index(c, cargo)
    assert int(idx) == assess(c, cargo).level
    assert 0 <= idx <= 4


def test_severity_index_shows_depth_within_band() -> None:
    assert severity_index(Conditions(30, 0, 0), 0) == pytest.approx(1.5)  # halfway 25-35
    assert severity_index(Conditions(55, 0, 0), 0) == 4.0
