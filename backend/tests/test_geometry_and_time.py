import itertools
import math

import pytest
from hypothesis import given
from hypothesis import strategies as st

from planner.domain import checkpoints, hos
from planner.domain.forecast import Series, sample_at, sample_hour
from planner.domain.geo import haversine_mi, offset_point, overlap_ratio
from planner.domain.polyline import decode
from planner.domain.route import from_maneuvers, from_segment_durations


def test_haversine_known_answer() -> None:
    # One degree of longitude on the equator.
    assert haversine_mi((0, 0), (0, 1)) == pytest.approx(69.0934, abs=1e-3)


def test_polyline_google_reference_string() -> None:
    # Google's documented example, precision 5.
    pts = decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@", precision=5)
    assert pts == [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]


@pytest.mark.parametrize(
    ("drive", "elapsed"),
    [(0, 0), (8, 8), (8.01, 8.51), (11, 11.5), (11.01, 21.51), (22, 33.0), (30, 51.0)],
)
def test_hours_of_service(drive: float, elapsed: float) -> None:
    assert hos.elapsed_hours(drive) == pytest.approx(elapsed)


@given(st.floats(0, 100, allow_nan=False))
def test_hos_never_shortens_and_is_monotonic(d: float) -> None:
    assert hos.elapsed_hours(d) >= d
    assert hos.elapsed_hours(d + 0.25) >= hos.elapsed_hours(d)


def test_hos_stops_listed_in_order() -> None:
    assert hos.stops(13.35) == [(8.0, "break", 0.5), (11.0, "rest", 10.0)]
    assert hos.stops(7.5) == []


def _straight_route(miles: float, mph: float = 60):
    # A due-north line: 1 degree of latitude is about 69.09 miles.
    n = 200
    lat_end = miles / 69.0934
    coords = [(lat_end * k / n, 0.0) for k in range(n + 1)]
    seg_s = miles / n / mph * 3600
    return from_segment_durations(coords, [seg_s] * n, total_s=seg_s * n)


def test_checkpoint_spacing_and_represented_miles_add_up() -> None:
    route = _straight_route(62.0)
    cps = checkpoints.build(route, 25, with_hos=False)
    assert [round(c.mile, 3) for c in cps] == [0, 25, 50, 62.0]
    assert [round(c.represented_mi, 3) for c in cps] == [12.5, 25, 18.5, 6.0]
    assert sum(c.represented_mi for c in cps) == pytest.approx(route.distance_mi)


@given(st.floats(1, 2500), st.sampled_from(checkpoints.INTERVALS_MI))
def test_represented_miles_always_sum_to_route_length(total: float, interval: int) -> None:
    miles = checkpoints.checkpoint_miles(total, interval)
    assert miles[0] == 0 and miles[-1] == pytest.approx(total)
    gaps = [b - a for a, b in itertools.pairwise(miles)]
    assert all(0 < g <= interval + 1e-9 for g in gaps)


def test_trip_shorter_than_interval_still_has_both_ends() -> None:
    cps = checkpoints.build(_straight_route(4.0), 10, with_hos=False)
    assert len(cps) == 2
    assert sum(c.represented_mi for c in cps) == pytest.approx(4.0, rel=1e-3)


def test_eta_follows_segment_speeds_not_an_average() -> None:
    # First half at 30 mph, second half at 60 mph: mile 50 of 100 is reached at 1.667 h.
    coords = [(k * 1 / 69.0934, 0.0) for k in range(101)]
    durs = [120.0] * 50 + [60.0] * 50
    route = from_segment_durations(coords, durs, total_s=sum(durs))
    assert checkpoints.drive_seconds_at(route, 50) == pytest.approx(6000, rel=1e-3)


def test_osrm_segments_are_capped_at_truck_speed() -> None:
    coords = [(k * 1 / 69.0934, 0.0) for k in range(11)]  # 10 miles
    route = from_segment_durations(coords, [36.0] * 10, total_s=360)  # 100 mph
    assert route.drive_s == pytest.approx(10 / 65 * 3600, rel=1e-3)


def test_maneuver_time_is_spread_by_distance() -> None:
    coords = [(k * 1 / 69.0934, 0.0) for k in range(11)]
    route = from_maneuvers(coords, [(0, 4, 400.0), (4, 10, 1200.0)])
    assert route.cum_drive_s[2] == pytest.approx(200)
    assert route.cum_drive_s[7] == pytest.approx(400 + 600)
    assert route.drive_s == pytest.approx(1600)


def test_overlap_ratio_identical_and_disjoint() -> None:
    a = [(39.0 + k * 0.01, -100.0) for k in range(100)]
    b = [(39.0 + k * 0.01, -99.0) for k in range(100)]
    assert overlap_ratio(a, a) == 1.0
    assert overlap_ratio(a, b) == 0.0


def test_offset_point_goes_left_of_travel() -> None:
    # Travelling north, left is west.
    lat, lon = offset_point((39.0, -100.0), (41.0, -100.0), 0.5, side_mi=50)
    assert lat == pytest.approx(40.0)
    assert lon < -100.0
    assert haversine_mi((40.0, -100.0), (lat, lon)) == pytest.approx(50, rel=0.01)


HOUR = 3600
T0 = 1_800_000_000 - (1_800_000_000 % HOUR)


def _series(**kw):
    base = {k: [0.0] * 6 for k in ("wind", "gust", "rain", "showers", "snow")}
    base.update(kw)
    return Series(start=T0, **base)


def test_precip_comes_from_the_hour_containing_the_eta() -> None:
    s = _series(rain=[0, 0.1, 0.2, 0.3, 0, 0])
    # 1h20m after T0 sits in the hour ending at T0+2h.
    assert sample_at(s, T0 + 4800).rain_in_hr == 0.2
    # Exactly on the hour: the hour ending then.
    assert sample_at(s, T0 + 2 * HOUR).rain_in_hr == 0.2


def test_sustained_wind_takes_the_larger_neighbour() -> None:
    s = _series(wind=[10, 30, 20, 0, 0, 0])
    assert sample_at(s, T0 + 5400).wind_mph == 30  # between 30 (1h) and 20 (2h)


def test_rain_and_showers_add_and_round() -> None:
    s = _series(rain=[0, 0.09, 0, 0, 0, 0], showers=[0, 0.01, 0, 0, 0, 0])
    assert sample_hour(s, T0 + HOUR).rain_in_hr == 0.10


def test_outside_forecast_is_unknown_not_calm() -> None:
    s = _series()
    sample = sample_at(s, T0 + 10 * HOUR)
    assert sample.wind_mph is None and sample.rain_in_hr is None
    nulls = _series(gust=[None] * 6)
    assert sample_at(nulls, T0 + 1800).gust_mph is None


def test_floor_ceil_hours_are_whole_hours() -> None:
    assert math.isclose(T0 % HOUR, 0)


def test_canada_outline() -> None:
    from planner.domain.borders import crosses_canada, in_canada

    assert in_canada((42.98, -81.25))  # London, Ontario
    assert in_canada((43.65, -79.38))  # Toronto
    assert in_canada((49.9, -97.1))  # Winnipeg
    assert not in_canada((42.33, -83.05))  # Detroit
    assert not in_canada((42.89, -78.88))  # Buffalo
    assert not in_canada((41.5, -81.7))  # Cleveland
    assert not in_canada((47.6, -122.3))  # Seattle
    assert crosses_canada([(42.33, -83.05), (42.98, -81.25), (42.89, -78.88)], step=1)
    assert not crosses_canada([(42.33, -83.05), (41.5, -81.7), (42.89, -78.88)], step=1)
