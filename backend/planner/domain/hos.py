"""US hours-of-service rules for property-carrying drivers (49 CFR 395.3), simplified.

The model assumes one driver who starts the trip fresh and drives whenever allowed:
- a 30-minute break after 8 hours of driving,
- a 10-hour rest after 11 hours of driving.
The 14-hour window and the 60/70-hour weekly limits are not modelled; for trips up to a
few days the 11-hour limit always binds first when driving is continuous.
"""

import math

BREAK_AFTER_H = 8.0
BREAK_H = 0.5
SHIFT_DRIVE_H = 11.0
REST_H = 10.0


def elapsed_hours(drive_h: float) -> float:
    """Wall-clock hours since departure when the truck has driven `drive_h` hours."""
    if drive_h <= 0:
        return 0.0
    # Shifts finished before this point. max() guards float underflow for tiny inputs.
    full_shifts = max(0, math.ceil(drive_h / SHIFT_DRIVE_H) - 1)
    in_shift = drive_h - full_shifts * SHIFT_DRIVE_H
    breaks = full_shifts + (1 if in_shift > BREAK_AFTER_H else 0)
    return drive_h + full_shifts * REST_H + breaks * BREAK_H


def stops(drive_h_total: float) -> list[tuple[float, str, float]]:
    """Required stops on a trip: (drive hour at which it starts, kind, duration hours)."""
    out: list[tuple[float, str, float]] = []
    t = 0.0
    while True:
        brk = t + BREAK_AFTER_H
        if brk >= drive_h_total:
            break
        out.append((brk, "break", BREAK_H))
        rest = t + SHIFT_DRIVE_H
        if rest >= drive_h_total:
            break
        out.append((rest, "rest", REST_H))
        t = rest
    return out
