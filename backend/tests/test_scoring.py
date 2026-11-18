from planner.domain.forecast import Sample
from planner.domain.grid import corridor
from planner.domain.risk import Level
from planner.domain.scoring import RouteSummary, point_risk, rank


def summary(rid: int, levels: tuple[float, ...], unknown: float = 0.0, trip_h: float = 10):
    total = sum(levels) + unknown
    return RouteSummary(rid, tuple(levels), unknown, total, trip_h * 3600)  # type: ignore[arg-type]


def test_fewest_severe_miles_beats_shorter_time() -> None:
    a = summary(0, (90, 0, 0, 10, 0), trip_h=10)
    b = summary(1, (100, 0, 0, 0, 0), trip_h=12)
    r = rank([a, b])
    assert r.order == [1, 0] and r.recommended == 1 and r.status == "ok"
    assert "Severe miles" in r.reasons[1]


def test_criteria_cascade_in_brief_order() -> None:
    a = summary(0, (80, 10, 10, 0, 0), trip_h=9)
    b = summary(1, (80, 0, 20, 0, 0), trip_h=8)  # more High miles
    c = summary(2, (70, 30, 0, 0, 0), trip_h=11)  # no High, more Moderate
    r = rank([a, b, c])
    assert r.order == [2, 0, 1]
    assert "High miles" in r.reasons[0]


def test_average_risk_then_time() -> None:
    a = summary(0, (100, 0, 0, 0, 0), trip_h=12)
    b = summary(1, (90, 10, 0, 0, 0), trip_h=10)
    assert rank([a, b]).order == [0, 1]
    c = summary(2, (100, 0, 0, 0, 0), trip_h=11)
    assert rank([a, c]).order == [2, 0]


def test_no_travel_is_ranked_before_severe_and_never_recommended() -> None:
    a = summary(0, (95, 0, 0, 0, 5))
    b = summary(1, (60, 0, 0, 40, 0))
    r = rank([a, b])
    assert r.order == [1, 0] and r.recommended == 1
    both_bad = rank([summary(0, (95, 0, 0, 0, 5)), summary(1, (90, 0, 0, 0, 10))])
    assert both_bad.recommended is None and both_bad.status == "all_no_travel"


def test_unknown_weather_blocks_a_recommendation_that_it_could_flip() -> None:
    a = summary(0, (90, 0, 0, 0, 0), unknown=10, trip_h=9)
    b = summary(1, (100, 0, 0, 0, 0), trip_h=10)
    r = rank([a, b])
    assert r.recommended is None and r.status == "weather_incomplete"


def test_unknown_that_cannot_change_the_winner_still_recommends() -> None:
    a = summary(0, (100, 0, 0, 0, 0), trip_h=9)
    b = summary(1, (50, 0, 0, 40, 0), unknown=10, trip_h=8)
    r = rank([a, b])
    assert r.recommended == 0 and r.status == "ok"


def test_no_weather_at_all() -> None:
    r = rank([summary(0, (0, 0, 0, 0, 0), unknown=100), summary(1, (0, 0, 0, 0, 0), unknown=90)])
    assert r.recommended is None and r.status == "no_weather"


def test_point_risk_wind_mode() -> None:
    s = Sample(wind_mph=30, gust_mph=56, rain_in_hr=0, snow_in_hr=0)
    assert point_risk(s, 0, "sustained").level == Level.MODERATE
    assert point_risk(s, 0, "gust").level == Level.NO_TRAVEL
    missing = Sample(wind_mph=30, gust_mph=None, rain_in_hr=0, snow_in_hr=0)
    assert point_risk(missing, 0, "gust").level is None


def test_corridor_covers_route_and_respects_budget() -> None:
    line = [(39.0 + k * 0.05, -105.0 + k * 0.05) for k in range(60)]
    cells = corridor([line], buffer_mi=20, max_cells=320)
    assert 0 < len(cells) <= 320
    assert [c.id for c in cells] == list(range(1, len(cells) + 1))
    long_line = [(30.0 + k * 0.1, -120.0 + k * 0.4) for k in range(120)]
    assert len(corridor([long_line], max_cells=320)) <= 320
