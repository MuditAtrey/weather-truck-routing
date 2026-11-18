"""Encoded polyline decoding (Google's algorithm) without a dependency.

Valhalla and our OSRM requests both use precision 6 ("polyline6"). The output is a
list of (lat, lon) tuples, matching the rest of the backend.
"""

from .geo import LatLon


def decode(encoded: str, precision: int = 6) -> list[LatLon]:
    factor = 10**precision
    coords: list[LatLon] = []
    index = lat = lon = 0
    length = len(encoded)
    while index < length:
        deltas = []
        for _ in range(2):
            shift = result = 0
            while True:
                byte = ord(encoded[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        lat += deltas[0]
        lon += deltas[1]
        coords.append((lat / factor, lon / factor))
    return coords
