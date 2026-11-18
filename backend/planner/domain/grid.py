"""The heatmap corridor: a lat/lon grid of cells around the candidate routes.

Cells are squares in degrees. A cell is kept if it is within `buffer_mi` of any route.
The cell size grows for long trips so the weather request stays within a fixed budget
of locations (Open-Meteo bills every location as one call).
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

from .geo import LatLon, resample

CELL_SIZES_DEG = (0.25, 0.35, 0.5, 0.75, 1.0)


@dataclass(frozen=True, slots=True)
class Cell:
    id: int  # starts at 1 (MapLibre feature-state needs non-zero integer ids)
    row: int
    col: int
    size: float

    @property
    def center(self) -> LatLon:
        return ((self.row + 0.5) * self.size, (self.col + 0.5) * self.size)

    @property
    def ring(self) -> list[tuple[float, float]]:
        """Closed polygon ring in GeoJSON [lon, lat] order."""
        s = self.size
        s_lat, w_lon = self.row * s, self.col * s
        return [
            (round(w_lon, 4), round(s_lat, 4)),
            (round(w_lon + s, 4), round(s_lat, 4)),
            (round(w_lon + s, 4), round(s_lat + s, 4)),
            (round(w_lon, 4), round(s_lat + s, 4)),
            (round(w_lon, 4), round(s_lat, 4)),
        ]


def _cells_for(
    routes: Sequence[Sequence[LatLon]], size: float, buffer_mi: float
) -> set[tuple[int, int]]:
    keys: set[tuple[int, int]] = set()
    for coords in routes:
        for lat, lon in resample(coords, 3.0):
            dlat = buffer_mi / 69.0
            dlon = buffer_mi / (69.172 * max(0.2, math.cos(math.radians(lat))))
            r0, r1 = math.floor((lat - dlat) / size), math.floor((lat + dlat) / size)
            c0, c1 = math.floor((lon - dlon) / size), math.floor((lon + dlon) / size)
            for r in range(r0, r1 + 1):
                for c in range(c0, c1 + 1):
                    # Keep cells whose centre is within the buffer (circle, not box).
                    clat, clon = (r + 0.5) * size, (c + 0.5) * size
                    dy = (clat - lat) * 69.0
                    dx = (clon - lon) * 69.172 * math.cos(math.radians(lat))
                    if math.hypot(dx, dy) <= buffer_mi + size * 69.0 * 0.5:
                        keys.add((r, c))
    return keys


def corridor(
    routes: Sequence[Sequence[LatLon]], buffer_mi: float = 20.0, max_cells: int = 320
) -> list[Cell]:
    keys: set[tuple[int, int]] = set()
    size = CELL_SIZES_DEG[-1]
    for size in CELL_SIZES_DEG:
        keys = _cells_for(routes, size, buffer_mi)
        if len(keys) <= max_cells:
            break
    ordered = sorted(keys)
    return [Cell(id=i + 1, row=r, col=c, size=size) for i, (r, c) in enumerate(ordered)]
