"""Export a waypoint route to ArduPilot-compatible mission files.

Two formats are produced:
  * QGC WPL 110  (.waypoints) - the tab-separated text format Mission Planner
    reads/writes.
  * QGC .plan    (.plan)      - the JSON format QGroundControl uses.

MAVLink reference used here:
  frame 0  = MAV_FRAME_GLOBAL                  (absolute alt, used by home)
  frame 3  = MAV_FRAME_GLOBAL_RELATIVE_ALT     (alt relative to home)
  cmd 16   = MAV_CMD_NAV_WAYPOINT
  cmd 20   = MAV_CMD_NAV_RETURN_TO_LAUNCH
  cmd 22   = MAV_CMD_NAV_TAKEOFF
"""
import json


# ---------------------------------------------------------------- QGC WPL 110

def _wpl_line(seq, current, frame, command, p1, p2, p3, p4, x, y, z):
    cols = [
        seq, current, frame, command,
        _num(p1), _num(p2), _num(p3), _num(p4),
        _num(x, 8), _num(y, 8), _num(z, 6),
        1,  # autocontinue
    ]
    return "\t".join(str(c) for c in cols)


def _num(v, places=6):
    return format(float(v), f".{places}f")


def to_waypoints(home, takeoff_alt, waypoints, wp_alt, add_rtl=True):
    """Build QGC WPL 110 (.waypoints) text.

    home: (lat, lon, abs_alt). waypoints: list of (lat, lon).
    """
    lines = ["QGC WPL 110"]
    seq = 0

    # WP0 = home (Mission Planner convention: absolute frame, current=1).
    lines.append(_wpl_line(seq, 1, 0, 16, 0, 0, 0, 0, home[0], home[1], home[2]))
    seq += 1

    # Takeoff to relative altitude above home.
    lines.append(_wpl_line(seq, 0, 3, 22, 0, 0, 0, 0, home[0], home[1], takeoff_alt))
    seq += 1

    for lat, lon in waypoints:
        lines.append(_wpl_line(seq, 0, 3, 16, 0, 0, 0, 0, lat, lon, wp_alt))
        seq += 1

    if add_rtl:
        lines.append(_wpl_line(seq, 0, 3, 20, 0, 0, 0, 0, 0, 0, 0))
        seq += 1

    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------- QGC .plan

def to_plan(home, takeoff_alt, waypoints, wp_alt, add_rtl=True,
            cruise_speed=12.0, hover_speed=5.0):
    """Build a QGroundControl .plan (JSON) string for an ArduCopter mission."""
    items = []
    jump = 1

    def simple(command, params, alt):
        nonlocal jump
        item = {
            "AMSLAltAboveTerrain": None,
            "Altitude": alt,
            "AltitudeMode": 1,            # 1 = relative to home
            "autoContinue": True,
            "command": command,
            "doJumpId": jump,
            "frame": 3,                   # MAV_FRAME_GLOBAL_RELATIVE_ALT
            "params": params,
            "type": "SimpleItem",
        }
        jump += 1
        return item

    # Copter takeoff has no horizontal target; QGC's own writer emits 0/0 for
    # lat/lon (params 5/6). ArduCopter ignores them, but 0/0 round-trips cleanly.
    items.append(simple(22, [0, 0, 0, 0, 0, 0, takeoff_alt], takeoff_alt))
    for lat, lon in waypoints:
        items.append(simple(16, [0, 0, 0, None, lat, lon, wp_alt], wp_alt))
    if add_rtl:
        items.append(simple(20, [0, 0, 0, 0, 0, 0, 0], 0))

    plan = {
        "fileType": "Plan",
        "geoFence": {"circles": [], "polygons": [], "version": 2},
        "groundStation": "FieldMissionPlanner",
        "mission": {
            "cruiseSpeed": cruise_speed,
            "firmwareType": 3,            # MAV_AUTOPILOT_ARDUPILOTMEGA
            "globalPlanAltitudeMode": 1,
            "hoverSpeed": hover_speed,
            "items": items,
            "plannedHomePosition": [home[0], home[1], home[2]],
            "vehicleType": 2,            # MAV_TYPE_QUADROTOR
            "version": 2,
        },
        "rallyPoints": {"points": [], "version": 2},
        "version": 1,
    }
    return json.dumps(plan, indent=4)


# ------------------------------------------------- field contour / geofence

def _contour_home(contour, home):
    if home is not None:
        return home
    la = sum(p[0] for p in contour) / len(contour)
    lo = sum(p[1] for p in contour) / len(contour)
    return (la, lo, 0.0)


def to_geofence_plan(contour, home=None, exclusions=None):
    """QGC/Mission Planner .plan geofence: the field contour as an INCLUSION
    polygon (keep the copter inside), plus one EXCLUSION polygon per obstacle
    (keep it out of trees/roads/ponds). No mission items."""
    h = _contour_home(contour, home)
    polygons = [{"inclusion": True,
                 "polygon": [[lat, lon] for (lat, lon) in contour], "version": 1}]
    for ex in (exclusions or []):
        if ex and len(ex) >= 3:
            polygons.append({"inclusion": False,
                             "polygon": [[lat, lon] for (lat, lon) in ex], "version": 1})
    plan = {
        "fileType": "Plan",
        "geoFence": {
            "circles": [],
            "polygons": polygons,
            "version": 2,
        },
        "groundStation": "FieldMissionPlanner",
        "mission": {
            "cruiseSpeed": 12, "firmwareType": 3, "globalPlanAltitudeMode": 1,
            "hoverSpeed": 5, "items": [],
            "plannedHomePosition": [h[0], h[1], h[2]],
            "vehicleType": 2, "version": 2,
        },
        "rallyPoints": {"points": [], "version": 2},
        "version": 1,
    }
    return json.dumps(plan, indent=4)


def to_fence_mp(contour, return_point=None):
    """Legacy ArduPilot/Mission Planner polygon-fence text.

    Line 1 = return point (lat lon); then one vertex per line; the first vertex
    is repeated at the end to close the polygon.
    """
    if return_point is None:
        la = sum(p[0] for p in contour) / len(contour)
        lo = sum(p[1] for p in contour) / len(contour)
        return_point = (la, lo)
    lines = [f"{return_point[0]:.8f} {return_point[1]:.8f}"]
    for lat, lon in contour:
        lines.append(f"{lat:.8f} {lon:.8f}")
    lines.append(f"{contour[0][0]:.8f} {contour[0][1]:.8f}")
    return "\n".join(lines) + "\n"


def to_contour_geojson(contour):
    """The contour as a GeoJSON Polygon (lon, lat order, closed ring)."""
    ring = [[lon, lat] for (lat, lon) in contour]
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    gj = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"name": "field_contour"},
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        }],
    }
    return json.dumps(gj, indent=2)
