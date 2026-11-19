"""A coarse check for routes that leave the United States through Canada.

Free routers happily send Detroit-Buffalo trips across southern Ontario, which means a
border crossing and customs for a truck. This is a deliberately rough outline (good to
a few miles), not a border dataset: enough to warn, not to adjudicate.
"""

import itertools
from collections.abc import Sequence

from .geo import LatLon

# Southern Ontario between the Detroit/St. Clair rivers and the Niagara river, (lat, lon).
SOUTHERN_ONTARIO: tuple[LatLon, ...] = (
    (42.05, -82.55),
    (41.95, -83.10),
    (42.30, -83.10),
    (42.35, -82.95),
    (42.65, -82.50),
    (43.00, -82.42),
    (45.30, -82.60),
    (46.30, -79.30),
    (45.00, -74.70),
    (44.10, -76.40),
    (43.60, -79.00),
    (43.25, -79.05),
    (42.85, -78.92),
    (42.60, -79.40),
    (42.05, -82.55),
)
WEST_BORDER_LAT = 49.0  # the 49th parallel, Lake of the Woods to the Pacific
WEST_BORDER_LON = (-123.3, -95.15)


def _inside(p: LatLon, poly: Sequence[LatLon]) -> bool:
    lat, lon = p
    inside = False
    for (a_lat, a_lon), (b_lat, b_lon) in itertools.pairwise(poly):
        if (a_lat > lat) != (b_lat > lat):
            x = a_lon + (lat - a_lat) * (b_lon - a_lon) / (b_lat - a_lat)
            if lon < x:
                inside = not inside
    return inside


def in_canada(p: LatLon) -> bool:
    lat, lon = p
    if WEST_BORDER_LON[0] <= lon <= WEST_BORDER_LON[1] and lat > WEST_BORDER_LAT + 0.02:
        return True
    return _inside(p, SOUTHERN_ONTARIO)


def crosses_canada(coords: Sequence[LatLon], step: int = 20) -> bool:
    return any(in_canada(p) for p in coords[::step])
