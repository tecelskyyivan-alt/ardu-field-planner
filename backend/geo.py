"""Geodetic helpers: local tangent-plane projection + distance.

For field-scale areas (sub-kilometre) an equirectangular projection around a
local origin is accurate to well under a metre, which is plenty for mission
planning. We project lat/lon -> local east/north metres, do all geometry in
metres, then project back.
"""
import math

R_EARTH = 6378137.0  # WGS84 equatorial radius (m)


def latlon_to_local(lat, lon, lat0, lon0):
    """Project (lat, lon) to local (east, north) metres around (lat0, lon0)."""
    dlat = math.radians(lat - lat0)
    dlon = math.radians(lon - lon0)
    east = dlon * math.cos(math.radians(lat0)) * R_EARTH
    north = dlat * R_EARTH
    return east, north


def local_to_latlon(east, north, lat0, lon0):
    """Inverse of latlon_to_local."""
    dlat = north / R_EARTH
    dlon = east / (R_EARTH * math.cos(math.radians(lat0)))
    lat = lat0 + math.degrees(dlat)
    lon = lon0 + math.degrees(dlon)
    return lat, lon


def haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres between two lat/lon points."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def path_length(points):
    """Total length (m) of a polyline given as a list of (lat, lon)."""
    total = 0.0
    for (a, b) in zip(points, points[1:]):
        total += haversine(a[0], a[1], b[0], b[1])
    return total


def centroid(points):
    """Simple average centroid of a list of (lat, lon)."""
    n = len(points)
    return (sum(p[0] for p in points) / n, sum(p[1] for p in points) / n)
