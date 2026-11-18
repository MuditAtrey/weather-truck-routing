"""Picking forecast values for a moment in time.

Open-Meteo's hourly series are stamped at the END of each hour for accumulated and
maximum variables: `rain`, `showers`, `snowfall` and `wind_gusts_10m` at 14:00 describe
13:00-14:00. `wind_speed_10m` is an instantaneous value at the stamp.

So for a truck arriving at 13:20:
- rain, snow and gusts come from the 14:00 value (the hour that contains 13:20),
- sustained wind is the larger of 13:00 and 14:00 (conservative between two snapshots).
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

HOUR = 3600


def floor_hour(epoch: float) -> int:
    return int(math.floor(epoch / HOUR) * HOUR)


def ceil_hour(epoch: float) -> int:
    return int(math.ceil(epoch / HOUR) * HOUR)


@dataclass(frozen=True, slots=True)
class Series:
    """Hourly values for one location, starting at `start` (epoch seconds, on the hour)."""

    start: int
    wind: Sequence[float | None]
    gust: Sequence[float | None]
    rain: Sequence[float | None]
    showers: Sequence[float | None]
    snow: Sequence[float | None]

    def _at(self, values: Sequence[float | None], epoch: int) -> float | None:
        i = (epoch - self.start) // HOUR
        if i < 0 or i >= len(values):
            return None
        return values[i]


@dataclass(frozen=True, slots=True)
class Sample:
    """Forecast for one moment. `None` means the forecast does not cover it."""

    wind_mph: float | None
    gust_mph: float | None
    rain_in_hr: float | None
    snow_in_hr: float | None


def _rain(series: Series, epoch: int) -> float | None:
    rain = series._at(series.rain, epoch)
    showers = series._at(series.showers, epoch)
    if rain is None and showers is None:
        return None
    # Showers are convective rain; both count as rain. Round to the API's precision
    # so 0.09 + 0.01 stays 0.10.
    return round((rain or 0.0) + (showers or 0.0), 3)


def sample_at(series: Series, epoch: float) -> Sample:
    lo, hi = floor_hour(epoch), ceil_hour(epoch)
    winds = [series._at(series.wind, h) for h in sorted({lo, hi})]
    wind = None if any(w is None for w in winds) else max(w for w in winds if w is not None)
    return Sample(
        wind_mph=wind,
        gust_mph=series._at(series.gust, hi),
        rain_in_hr=_rain(series, hi),
        snow_in_hr=series._at(series.snow, hi),
    )


def sample_hour(series: Series, hour_end: int) -> Sample:
    """The forecast for the hour ending at `hour_end` (used by the heatmap)."""
    return Sample(
        wind_mph=series._at(series.wind, hour_end),
        gust_mph=series._at(series.gust, hour_end),
        rain_in_hr=_rain(series, hour_end),
        snow_in_hr=series._at(series.snow, hour_end),
    )
