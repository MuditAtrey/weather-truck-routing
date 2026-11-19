import pytest

from planner.domain import rest_stops
from planner.domain.rest_stops import Site, plan
from planner.domain.route import from_segment_durations

H = 3600


def straight_route(miles: float, mph: float = 60.0, lon: float = -100.0):
    n = int(miles)  # one-mile segments heading north
    coords = [(35.0 + k / 69.0934, lon) for k in range(n + 1)]
    seg = 3600 / mph
    return from_segment_durations(coords, [seg] * n, seg * n)


def site_at_mile(mile: float, kind: str = "truck_stop", spaces: int | None = None, name: str = "S"):
    return Site(35.0 + mile / 69.0934, -100.0, kind, name, None, None, spaces, "osm")


@pytest.fixture
def sites(monkeypatch: pytest.MonkeyPatch):
    placed: list[Site] = []

    def index():
        grid: dict = {}
        for s in placed:
            key = (int(s.lat // rest_stops.CELL), int(s.lon // rest_stops.CELL))
            grid.setdefault(key, []).append(s)
        return grid

    monkeypatch.setattr(rest_stops, "_index", index)
    return placed


def test_stops_go_to_the_latest_site_before_each_limit(sites) -> None:
    # 60 mph: 8 h = mile 480, 11 h = mile 660.
    sites += [site_at_mile(300), site_at_mile(450), site_at_mile(500)]  # 500 is after 8 h
    sites += [site_at_mile(600, "public", 30), site_at_mile(640, "public", 25)]
    s = plan(straight_route(800))
    assert [st.kind for st in s.stops] == ["break", "rest"]
    brk, rest = s.stops
    assert brk.mile == pytest.approx(450, abs=0.6)  # latest before the limit, never after
    assert rest.mile == pytest.approx(640, abs=0.6)
    assert rest.early_s == pytest.approx(20 * 60, abs=60)  # 20 minutes before 11 h


def test_no_site_keeps_the_clock_position_and_says_so(sites) -> None:
    s = plan(straight_route(700))
    brk, rest = s.stops
    assert brk.site is None and brk.drive_s == 8 * H
    assert rest.site is None and rest.drive_s == 11 * H


def test_weigh_stations_are_not_used_for_the_10_hour_rest(sites) -> None:
    sites += [site_at_mile(450), site_at_mile(650, "public", 40, "Weigh Station I-80 WB")]
    sites += [site_at_mile(560, "public", 25, "Rest Area")]
    rest = plan(straight_route(800)).stops[1]
    assert rest.site is not None and rest.site.name == "Rest Area"


def test_schedule_times_include_each_stop_once(sites) -> None:
    sites += [site_at_mile(450), site_at_mile(640, "public", 30)]
    s = plan(straight_route(800))
    brk, rest = s.stops
    assert s.starts_at(brk) == pytest.approx(brk.drive_s)
    assert s.starts_at(rest) == pytest.approx(rest.drive_s + 0.5 * H)
    assert s.elapsed(800 * 60) == pytest.approx(800 * 60 + 10.5 * H)


def test_short_trip_needs_no_stops(sites) -> None:
    assert plan(straight_route(400)).stops == []


def test_real_data_finds_sites_on_a_real_route() -> None:
    import json
    from pathlib import Path

    from planner.providers import valhalla

    data = json.loads((Path(__file__).parent / "fixtures" / "valhalla_dal_den.json").read_text())
    route = valhalla.parse(data)[0]  # Dallas to Denver, about 14 h of driving
    s = plan(route)
    assert [st.kind for st in s.stops] == ["break", "rest"]
    assert all(st.site is not None for st in s.stops)
    assert all(st.early_s >= 0 for st in s.stops)


def test_a_late_small_site_beats_an_early_big_one_when_no_truck_stop_fits(sites) -> None:
    # Break at a truck stop; for the rest only a big early area (8.2 h) and a small late one.
    sites += [site_at_mile(450), site_at_mile(492, "public", 60, "Big Rest Area")]
    sites += [site_at_mile(650, "public", 6, "Small Rest Area")]
    rest = plan(straight_route(800)).stops[1]
    # The big one is tier 0 but only 8.2 h in; the latest legal site 9-11 h in wins.
    assert rest.site is not None and rest.site.name == "Small Rest Area"
