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
  cmd 19   = MAV_CMD_NAV_LOITER_TIME
  cmd 21   = MAV_CMD_NAV_LAND
  cmd 178  = MAV_CMD_DO_CHANGE_SPEED
  frame 10 = MAV_FRAME_GLOBAL_TERRAIN_ALT      (alt above the ground under the drone)

`mission_items` is the ONE layout both the file export and the desktop upload use
(web-stable/mav/link.js buildMissionItems mirrors it for the browser upload), so a
file and an upload of the same plan carry the same home, speed and end (#52-#54).
"""
import json

FRAME_GLOBAL, FRAME_REL, FRAME_TERRAIN = 0, 3, 10
CMD_WAYPOINT, CMD_LOITER_TIME, CMD_RTL, CMD_LAND, CMD_TAKEOFF = 16, 19, 20, 21, 22
CMD_DO_CHANGE_SPEED = 178
# GPS-denied (VIO) profile, from ardu-gps-denied's flights: the climb frames over home are
# the home-fix keys (5 s), the hover back over home is where the image registration
# corrects the VIO (25 s; corrections of 1.2-8.4 m measured 2026-11-02). FMP issue #54.
VIO_HOLD_START_S = 5.0
VIO_HOLD_END_S = 25.0
# Then up over home to VIO_KEY_TOP_M and back down to the mission height before the route (Ivan 05.11: always): the
# companion keys 60 / 80 / 100 m on the way, and its 100 m retry stage finds home 50-90 m off (M17: 91 / 55 % of
# frames against 10 / 0 % with keys to 40 m). 105, not 100: a key is the first frame AT or above its level.
VIO_KEY_TOP_M = 105.0
VIO_KEY_TOP_S = 3.0


def mission_items(home, takeoff_alt, waypoints, wp_alt, rtl=True, speed=0.0,
                  vio=False, terrain=False):
    """Ordered mission rows (frame, command, p1, p2, p3, p4, lat, lon, alt); row 0 = home.

    GPS:  home · TAKEOFF · [DO_CHANGE_SPEED] · waypoints · [RTL]
    VIO:  home · TAKEOFF · LOITER_TIME 5 · LOITER_TIME 3 at 105 m · LOITER_TIME 1 back at takeoff_alt ·
          [DO_CHANGE_SPEED] · waypoints · WP home · LOITER_TIME 25 · LAND (home)  — `rtl` is ignored: the end is fixed.
    The climb is LOITER_TIME over home, not WAYPOINT: the route stays the only waypoints (ardu-gps-denied's loader
    flies one altitude frame for the whole body), and the transit leaves at the mission height.
    terrain=True puts the waypoints (and the VIO end over home) in frame 10, so the
    altitude is above the ground under the drone (the VIO stack holds it on the
    rangefinder); the takeoff stays relative to home."""
    la0, lo0 = float(home[0]), float(home[1])
    wf = FRAME_TERRAIN if terrain else FRAME_REL
    rows = [(FRAME_GLOBAL, CMD_WAYPOINT, 0, 0, 0, 0, la0, lo0, float(home[2]) if len(home) > 2 else 0.0),
            (FRAME_REL, CMD_TAKEOFF, 0, 0, 0, 0, la0, lo0, float(takeoff_alt))]
    if vio:
        rows += [(FRAME_REL, CMD_LOITER_TIME, VIO_HOLD_START_S, 0, 0, 0, la0, lo0, float(takeoff_alt)),
                 (FRAME_REL, CMD_LOITER_TIME, VIO_KEY_TOP_S, 0, 0, 0, la0, lo0, VIO_KEY_TOP_M),
                 (FRAME_REL, CMD_LOITER_TIME, 1.0, 0, 0, 0, la0, lo0, float(takeoff_alt))]
    if speed and float(speed) > 0:
        # type 1 = groundspeed, m/s, throttle -1 = no change
        rows.append((FRAME_REL, CMD_DO_CHANGE_SPEED, 1.0, float(speed), -1.0, 0, 0.0, 0.0, 0.0))
    rows += [(wf, CMD_WAYPOINT, 0, 0, 0, 0, float(la), float(lo), float(wp_alt)) for la, lo in waypoints]
    if vio:
        rows += [(wf, CMD_WAYPOINT, 0, 0, 0, 0, la0, lo0, float(wp_alt)),
                 (wf, CMD_LOITER_TIME, VIO_HOLD_END_S, 0, 0, 0, la0, lo0, float(wp_alt)),
                 (FRAME_REL, CMD_LAND, 0, 0, 0, 0, la0, lo0, 0.0)]
    elif rtl:
        rows.append((FRAME_REL, CMD_RTL, 0, 0, 0, 0, 0.0, 0.0, 0.0))
    return rows


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


def to_waypoints(home, takeoff_alt, waypoints, wp_alt, add_rtl=True, speed=0.0,
                 vio=False, terrain=False):
    """Build QGC WPL 110 (.waypoints) text.

    home: (lat, lon, abs_alt). waypoints: list of (lat, lon). Rows = mission_items().
    WP0 = home (Mission Planner convention: absolute frame, current=1)."""
    lines = ["QGC WPL 110"]
    for seq, r in enumerate(mission_items(home, takeoff_alt, waypoints, wp_alt, add_rtl,
                                          speed, vio, terrain)):
        lines.append(_wpl_line(seq, 1 if seq == 0 else 0, *r))
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------- QGC .plan

def to_plan(home, takeoff_alt, waypoints, wp_alt, add_rtl=True,
            cruise_speed=12.0, hover_speed=5.0, speed=0.0, vio=False, terrain=False):
    """Build a QGroundControl .plan (JSON) string for an ArduCopter mission.

    Items = mission_items() without row 0 (QGC keeps home in plannedHomePosition)."""
    items = []
    # QGC AltitudeMode per frame: 1 = relative to home, 4 = terrain frame.
    alt_mode = {FRAME_REL: 1, FRAME_TERRAIN: 4}
    for jump, (frame, cmd, p1, p2, p3, p4, la, lo, alt) in enumerate(
            mission_items(home, takeoff_alt, waypoints, wp_alt, add_rtl, speed, vio, terrain)[1:], 1):
        if cmd == CMD_DO_CHANGE_SPEED:
            # QGC writes DO_* items in MAV_FRAME_MISSION (2) with no altitude.
            items.append({"autoContinue": True, "command": cmd, "doJumpId": jump, "frame": 2,
                          "params": [p1, p2, p3, 0, 0, 0, 0], "type": "SimpleItem"})
            continue
        if cmd in (CMD_TAKEOFF, CMD_RTL):
            # Copter takeoff has no horizontal target; QGC's own writer emits 0/0 for
            # lat/lon (params 5/6). ArduCopter ignores them, but 0/0 round-trips cleanly.
            params = [0, 0, 0, 0, 0, 0, alt]
        else:
            params = [p1, p2, p3, None if cmd == CMD_WAYPOINT else p4, la, lo, alt]
        items.append({
            "AMSLAltAboveTerrain": None,
            "Altitude": alt,
            "AltitudeMode": alt_mode.get(frame, 1),
            "autoContinue": True,
            "command": cmd,
            "doJumpId": jump,
            "frame": frame,
            "params": params,
            "type": "SimpleItem",
        })

    plan = {
        "fileType": "Plan",
        "geoFence": {"circles": [], "polygons": [], "version": 2},
        "groundStation": "FieldMissionPlanner",
        "mission": {
            "cruiseSpeed": cruise_speed,
            "firmwareType": 3,            # MAV_AUTOPILOT_ARDUPILOTMEGA
            "globalPlanAltitudeMode": 0 if terrain else 1,   # 0 = mixed: per-item modes
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
