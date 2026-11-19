"""Weather risk classification, exactly as the brief's tables define it.

Band edges follow the table literally:
- every band includes its lower edge ("25-34" starts at 25.0, "No Travel" is >= 55 mph),
- the top bands for rain and snow are strict ("> 1.00", "> 3.0"), so exactly 1.00 in/hr
  of rain or 3.0 in/hr of snow is still Severe,
- values between the table's printed integers (34.5 mph) belong to the band below the
  next edge, so the bands are [25, 35), [35, 45), [45, 55).
Inputs are rounded to the forecast's own precision (0.1 mph, 0.001 in/hr) before
comparison, so float noise such as 0.09 + 0.01 = 0.0999... cannot move a band.
"""

from dataclasses import dataclass
from enum import IntEnum


class Level(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4


LEVEL_LABELS = {
    Level.LOW: "Low",
    Level.MODERATE: "Moderate",
    Level.HIGH: "High",
    Level.SEVERE: "Severe",
    Level.NO_TRAVEL: "No Travel",
}

# Lower edges of Moderate, High, Severe for each condition.
WIND_EDGES_MPH = (25.0, 35.0, 45.0)
WIND_NO_TRAVEL_MPH = 55.0  # inclusive
RAIN_EDGES_IN_HR = (0.10, 0.25, 0.50)
RAIN_NO_TRAVEL_IN_HR = 1.00  # strict
SNOW_EDGES_IN_HR = (0.5, 1.0, 2.0)
SNOW_NO_TRAVEL_IN_HR = 3.0  # strict

# Load rules (pounds of cargo).
NO_TRAVEL_WIND_LOAD_LB = 30_000  # 45-54 mph with more than this: No Travel
SEVERE_WIND_LOAD_LB = 40_000  # 35-44 mph with more than this: Severe


def _band(value: float, edges: tuple[float, float, float]) -> Level:
    if value < edges[0]:
        return Level.LOW
    if value < edges[1]:
        return Level.MODERATE
    if value < edges[2]:
        return Level.HIGH
    return Level.SEVERE


def wind_level(mph: float) -> Level:
    mph = round(mph, 1)
    if mph >= WIND_NO_TRAVEL_MPH:
        return Level.NO_TRAVEL
    return _band(mph, WIND_EDGES_MPH)


def rain_level(in_hr: float) -> Level:
    in_hr = round(in_hr, 3)
    if in_hr > RAIN_NO_TRAVEL_IN_HR:
        return Level.NO_TRAVEL
    return _band(in_hr, RAIN_EDGES_IN_HR)


def snow_level(in_hr: float) -> Level:
    in_hr = round(in_hr, 3)
    if in_hr > SNOW_NO_TRAVEL_IN_HR:
        return Level.NO_TRAVEL
    return _band(in_hr, SNOW_EDGES_IN_HR)


def load_adjusted_wind_level(mph: float, cargo_lb: int) -> Level:
    """Wind level after the brief's load rules."""
    base = wind_level(mph)
    if base == Level.SEVERE and cargo_lb > NO_TRAVEL_WIND_LOAD_LB:
        return Level.NO_TRAVEL
    if base == Level.HIGH and cargo_lb > SEVERE_WIND_LOAD_LB:
        return Level.SEVERE
    return base


@dataclass(frozen=True, slots=True)
class Conditions:
    """Forecast at one place and hour, already in the brief's units."""

    wind_mph: float
    rain_in_hr: float
    snow_in_hr: float


@dataclass(frozen=True, slots=True)
class Assessment:
    level: Level
    wind: Level
    rain: Level
    snow: Level

    @property
    def driver(self) -> str:
        """Which condition set the overall level (the first one, on ties)."""
        for name, lvl in (("wind", self.wind), ("snow", self.snow), ("rain", self.rain)):
            if lvl == self.level:
                return name
        return "wind"


def _fraction(value: float, edges: tuple[float, float, float], top: float, level: Level) -> float:
    """How far `value` sits through its band, 0 to just under 1 (0 for No Travel)."""
    bounds = (0.0, *edges, top)
    if level >= Level.NO_TRAVEL:
        return 0.0
    lo, hi = bounds[level], bounds[level + 1]
    return min(0.99, max(0.0, (value - lo) / (hi - lo)))


def severity_index(c: Conditions, cargo_lb: int) -> float:
    """A continuous 0-4 risk value for smooth shading.

    Its whole-number part is always the risk level, so a smoothed heatmap can never
    disagree with the level used for scoring; the fraction says how deep into that band
    the deciding condition is.
    """
    a = assess(c, cargo_lb)
    fractions = [0.0]
    if a.wind == a.level and a.wind == wind_level(c.wind_mph):  # not bumped by a load rule
        fractions.append(
            _fraction(round(c.wind_mph, 1), WIND_EDGES_MPH, WIND_NO_TRAVEL_MPH, a.wind)
        )
    if a.rain == a.level:
        fractions.append(_fraction(c.rain_in_hr, RAIN_EDGES_IN_HR, RAIN_NO_TRAVEL_IN_HR, a.rain))
    if a.snow == a.level:
        fractions.append(_fraction(c.snow_in_hr, SNOW_EDGES_IN_HR, SNOW_NO_TRAVEL_IN_HR, a.snow))
    return int(a.level) + max(fractions)


def assess(c: Conditions, cargo_lb: int) -> Assessment:
    """Overall risk is the worst of wind (after load rules), rain and snow."""
    wind = load_adjusted_wind_level(c.wind_mph, cargo_lb)
    rain = rain_level(c.rain_in_hr)
    snow = snow_level(c.snow_in_hr)
    return Assessment(level=max(wind, rain, snow), wind=wind, rain=rain, snow=snow)
