"""pywebview JS API: the bridge between the Leaflet UI and the Python core.

Methods on this class are callable from JavaScript as
    window.pywebview.api.<method>(...)
and return values (or Promises resolving to them) back to the page.
"""
import base64
import json
import os
import time

try:                       # only used by the legacy pywebview desktop window;
    import webview         # absent on the Qt app and the headless AI server.
except Exception:
    webview = None

from .coverage import (
    generate_coverage, polygon_area_ha, inset_boundary, expand_exclusions, optimal_angle,
    split_route_by_time, split_route_by_area, covered_area_ha, estimate_mission_time,
    coverage_metrics, split_field_by_line, overlap_optimal_angle, mission_overlap,
    return_corridor_route, coverage_overlap_geo,
)
from .geo import centroid, path_length, haversine
from .mission import (
    to_waypoints, to_plan,
    to_geofence_plan, to_fence_mp, to_contour_geojson,
)


class Api:
    def __init__(self):
        self.window = None
        self._state = None  # cached last-built mission

    def set_window(self, window):
        self.window = window

    def _route_for(self, boundary, spacing, angle, margin, auto_angle, exclusions,
                   anchor_ll, sfa, optimize="overlap", speed=12.0):
        """Build one coverage route for a (sub-)field boundary. Returns
        (wps_or_None, angle_used, cover_or_None). cover=None means the field is too
        small for the spacing/margin; wps=None means coverage couldn't be built.

        With auto_angle + optimize="overlap" (the default for an always-on sprayer),
        the heading is chosen to minimize TRUE spray overlap (full flown path incl.
        RTL). optimize="length" keeps the old min-path heading (cheaper — used for
        live drags). With start_finish_anchor (sfa), the route uses the productive
        RETURN CORRIDOR: the least-overlap snake plus a perimeter tail that sprays
        the bare edge strip on the way back and FINISHES exactly at home (no dead
        RTL) — measured slightly BELOW the plain overlap optimum."""
        swath = spacing / 2.0
        cover = inset_boundary(boundary, margin)
        if not cover or len(cover) < 3:
            return None, angle, None
        home = anchor_ll if anchor_ll is not None else centroid(boundary)
        if not auto_angle:
            wps = generate_coverage(cover, spacing, angle, exclusions=exclusions, anchor=anchor_ll)
            if (sfa and wps and len(wps) >= 2
                    and haversine(home[0], home[1], wps[-1][0], wps[-1][1])
                    > haversine(home[0], home[1], wps[0][0], wps[0][1])):
                wps = wps[::-1]                        # manual angle: just finish nearer home
            return (wps or None), angle, cover
        if sfa:
            ang, wps = return_corridor_route(cover, spacing, home, field_boundary=boundary,
                                             exclusions=exclusions, anchor=anchor_ll, return_route=True)
        elif optimize == "overlap":
            ang, wps = overlap_optimal_angle(cover, spacing, home, field_boundary=boundary,
                                             exclusions=exclusions, anchor=anchor_ll, return_route=True,
                                             speed=speed)
        else:
            ang, wps = optimal_angle(cover, spacing, exclusions=exclusions,
                                     return_route=True, anchor=anchor_ll)
        if not wps:
            ang = angle
            wps = generate_coverage(cover, spacing, angle, exclusions=exclusions, anchor=anchor_ll)
        return (wps or None), ang, cover

    # ----------------------------------------------------------- route build
    def build_route(self, params):
        """Generate a coverage route from a drawn field polygon.

        params: {
            boundary: [{lat, lng}, ...],
            spacing: float (m),  angle: float (deg),
            alt: float (m),      takeoff_alt: float (m),
            rtl: bool,           speed: float (m/s),
        }
        """
        try:
            boundary = [(float(p["lat"]), float(p["lng"])) for p in params["boundary"]]
            if len(boundary) < 3:
                return {"ok": False, "error": "Потрібно щонайменше 3 точки полігону."}

            spacing = float(params.get("spacing", 20))
            angle = float(params.get("angle", 0))
            alt = float(params.get("alt", 50))
            # No separate takeoff height: the copter takes off where it ARMS and
            # climbs straight to the mission altitude. Keep a tiny floor so
            # NAV_TAKEOFF (which never completes at 0 m) is always valid.
            takeoff_alt = max(alt, 2.0)
            rtl = bool(params.get("rtl", True))
            speed = max(float(params.get("speed", 12)), 0.1)
            margin = max(float(params.get("margin", 0)), 0.0)
            auto_angle = bool(params.get("auto_angle", False))
            exclusions = [
                [(float(p["lat"]), float(p["lng"])) for p in ex]
                for ex in (params.get("exclusions") or []) if len(ex) >= 3
            ]
            # «Відступ від країв» діє і на вирізи, ДЗЕРКАЛЬНО: поле стискається
            # всередину, перешкоди розширюються назовні на ту саму величину — дрон
            # тримає однакову дистанцію від краю поля і від краю дерева/стовпа.
            # Розширюємо ОДИН раз тут: маршрут, sprayed/excluded_ha і геозона далі
            # використовують ті самі розширені кільця (консистентно); намальовані
            # користувачем контури в UI лишаються як є.
            if margin > 0 and exclusions:
                exclusions = expand_exclusions(exclusions, margin)

            # Anchor: the operator's takeoff / GPS / chosen point. Routes begin (and
            # with start_finish_anchor, also finish) at the field point nearest it.
            anchor = params.get("anchor") or params.get("start")
            anchor_ll = None
            if anchor:
                try:
                    anchor_ll = (float(anchor["lat"]), float(anchor["lng"]))
                except (KeyError, TypeError, ValueError):
                    anchor_ll = None
            # Out-and-back (start = finish near the anchor): the drone returns to
            # you, but it RAISES spray overlap for an always-on sprayer, so it is
            # OPT-IN (default off). The default planner minimizes overlap instead.
            sfa = bool(params.get("start_finish_anchor", False))
            optimize = params.get("optimize", "overlap")        # "overlap" | "length"

            split = params.get("split") or {}
            # Manual sector split: one or MORE drawn lines cut the field into sub-
            # polygons, each covered as its own flight (basis for multi-drone later).
            # Multiple lines cut ITERATIVELY — each line splits every current piece.
            sectors = None
            if split.get("mode") == "manual_line":
                raw = split.get("lines")
                if not raw and split.get("line"):
                    raw = [split.get("line")]
                lines = []
                for ln in (raw or []):
                    pts = [(float(p["lat"]), float(p["lng"]))
                           for p in (ln or []) if "lat" in p and "lng" in p]
                    if len(pts) >= 2:
                        lines.append(pts)
                if lines:
                    pieces = [boundary]
                    for ln in lines:
                        nxt = []
                        for piece in pieces:
                            secs = split_field_by_line(piece, ln, exclusions)
                            if len(secs) >= 2:
                                nxt.extend(secs)
                            else:
                                nxt.append(piece)        # this line didn't cut this piece
                        pieces = nxt
                    # Cap the blow-up: K crossing lines can make up to 2^K sectors,
                    # each running a full angle sweep — guard against a freeze. (bug-hunt #9)
                    if len(pieces) > 24:
                        return {"ok": False, "error": "Забагато ліній поділу — зменши кількість секторів."}
                    if len(pieces) >= 2:
                        sectors = pieces

            if sectors:
                flights, wps = [], []
                seed = angle                       # keep the USER's seed for every sector (bug-hunt #6)
                sec_angles = []
                for sec in sectors:
                    w, sec_ang, _ = self._route_for(sec, spacing, seed, margin,
                                                    auto_angle, exclusions, anchor_ll, sfa, optimize, speed)
                    if not w:
                        # A sub-field too small to cover must NOT be silently dropped
                        # (the operator would think the whole field is sprayed). (bug-hunt #7)
                        return {"ok": False,
                                "error": "Сектор замалий для покриття — змісти лінію поділу або зменши крок/відступ."}
                    flights.append(w)
                    wps.extend(w)
                    sec_angles.append(round(sec_ang, 1))
                # Report a single angle only if all sectors agree; else mark multi-heading.
                angle = sec_angles[0] if len(set(sec_angles)) == 1 else angle
                cover = inset_boundary(boundary, margin) or boundary   # passes reach the edge (full coverage)
            else:
                wps, angle, cover = self._route_for(boundary, spacing, angle, margin,
                                                    auto_angle, exclusions, anchor_ll, sfa, optimize, speed)
                if cover is None:
                    return {"ok": False, "error": "Поле замале для цього кроку — зменши крок або відступ."}
                if not wps:
                    return {"ok": False, "error": "Не вдалося побудувати проходи — спробуй менший крок або інший кут."}
                flights = None

            home = (*centroid(boundary), 0.0)
            length = path_length(wps)
            area = polygon_area_ha(boundary)        # real field area (spray reaches the edge)
            sprayed = covered_area_ha(boundary, exclusions) if exclusions else area
            excluded = max(0.0, area - sprayed)
            cov = coverage_metrics(wps, boundary, exclusions, spacing)
            # TRUE overlap for the always-on sprayer: the full flown path (lead-in +
            # passes + connectors + RTL) all spray, so this is what the operator wastes.
            # Measure from the ACTUAL takeoff (anchor if set, else centroid) — the same
            # home the overlap-optimal heading was chosen for, so they stay consistent.
            ov_home = anchor_ll if anchor_ll is not None else (home[0], home[1])
            mo = mission_overlap(ov_home, wps, spacing, boundary, rtl=rtl)
            # Spray-footprint overlay (the swept swath + the double-sprayed area), only
            # when the UI asks for it — it is skipped on live angle drags to stay snappy.
            spray_geo = (coverage_overlap_geo(ov_home, wps, spacing, rtl=rtl)
                         if params.get("viz") else None)
            # Realistic flight-time estimate (takeoff / lead-in / cruise / turn
            # deceleration / RTL / landing descent), optionally calibrated by the
            # operator's logged real flights. Replaces the naive length / speed.
            # Calibration from logged real flights (offline): an explicit dict
            # wins, otherwise derive it from compact flight records via flight_calib.
            cal = params.get("calibration")
            if not cal:
                recs = params.get("flight_records")
                if recs:
                    from .flight_calib import calibrate
                    cal = calibrate(recs)
            time_est = estimate_mission_time(
                wps, home, wp_alt=alt, takeoff_alt=takeoff_alt, speed=speed,
                rtl=rtl, cal=cal)
            duration_s = time_est["total_s"]

            # Spray-liquid planning: rate (l/ha) over the sprayed area -> total
            # working solution, and how many tank fills it needs.
            flow_lha = max(float(params.get("flow_lha", 0) or 0), 0.0)
            tank_l = max(float(params.get("tank_l", 0) or 0), 0.0)
            liquid_l = sprayed * flow_lha
            refills = int(-(-liquid_l // tank_l)) if (tank_l > 0 and liquid_l > 0) else 0

            # Mission split into separate flights/sections (skipped when a manual
            # sector split already produced per-sector flights above):
            #   split.mode "n_area"       -> N sections of ~equal sprayed area
            #   split.mode "battery_time" -> as many flights as the endurance allows
            if flights is None:
                split_mode = split.get("mode")
                battery_min = float(params.get("battery_min", 0) or 0)
                if split_mode == "n_area":
                    flights = split_route_by_area(wps, spacing, int(split.get("n", 2) or 2))
                elif split_mode == "battery_time" or (not split_mode and battery_min > 0):
                    bm = float(split.get("battery_min", battery_min) or battery_min)
                    flights = split_route_by_time(wps, speed, bm * 60) if bm > 0 else [wps]
                else:
                    flights = [wps]

            self._state = {
                "home": home, "takeoff_alt": takeoff_alt,
                "waypoints": wps, "wp_alt": alt, "rtl": rtl,
                "speed": speed, "contour": boundary, "flights": flights,
                "exclusions": exclusions,
            }

            return {
                "ok": True,
                "waypoints": [{"lat": a, "lng": b} for a, b in wps],
                "contour": [{"lat": a, "lng": b} for a, b in boundary],
                "cover": [{"lat": a, "lng": b} for a, b in cover],
                "home": {"lat": home[0], "lng": home[1]},
                "count": len(wps),
                "length_m": round(length, 1),
                "area_ha": round(area, 3),
                "sprayed_ha": round(sprayed, 3),
                "excluded_ha": round(excluded, 3),
                "coverage_pct": cov["coverage_pct"],
                "overlap_pct": mo["overlap_pct"],      # TRUE overlap incl. lead-in + RTL
                "outside_ha": mo["outside_ha"],        # spray that lands outside the field
                "coverage_geo": (spray_geo or {}).get("coverage"),  # swept-swath rings (lat/lng)
                "overlap_geo": (spray_geo or {}).get("overlap"),    # double-sprayed rings
                "start_finish_anchor": sfa,
                "liquid_l": round(liquid_l, 1),
                "refills": refills,
                "duration_s": round(duration_s),
                "duration_breakdown": {k: round(v, 1) for k, v in time_est.items()},
                "calibration": cal or None,
                "angle_used": round(angle, 1),
                "margin": margin,
                "flights": len(flights),
                "sections": [
                    {"area_ha": round(path_length(fl) * spacing / 10000.0, 2),
                     "duration_s": round(estimate_mission_time(
                         fl, home, wp_alt=alt, takeoff_alt=takeoff_alt,
                         speed=speed, rtl=rtl, cal=cal)["total_s"])}
                    for fl in flights
                ] if len(flights) > 1 else [],
                "sectors": [[{"lat": a, "lng": b} for a, b in sec] for sec in (sectors or [])],
            }
        except Exception as exc:  # surface errors to the UI instead of dying
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    # ------------------------------------------------------ live MAVLink link
    def mav_connect(self, params):
        """Open a live MAVLink link to an ArduPilot vehicle (serial COM / UDP / TCP)."""
        try:
            from .mavlink_link import LINK
            conn = (params or {}).get("conn") or ""
            if not conn:
                return {"ok": False, "error": "Вкажи порт/адресу (напр. COM7 або udp:127.0.0.1:14550)."}
            baud = (params or {}).get("baud", "auto")   # "auto" or a number
            return LINK.connect(conn, baud)
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    def mav_ports(self, params=None):
        """List serial ports (USB cable / telemetry radio) so the UI can offer
        them in a dropdown instead of the user guessing COM numbers."""
        try:
            from serial.tools import list_ports
            ports = []
            for p in list_ports.comports():
                ports.append({"device": p.device,
                              "desc": (p.description or "").strip(),
                              "hwid": (p.hwid or "").strip()})
            # Likely-flight-controller / radio ports first (CubePilot, FTDI,
            # SiK radio, Pixhawk, STM32 VCP, CP210x, CH340).
            kw = ("ardu", "px4", "pixhawk", "cube", "mavlink", "sik", "radio",
                  "ftdi", "cp210", "ch340", "stm", "usb serial", "uart")
            ports.sort(key=lambda d: 0 if any(k in (d["desc"] + d["hwid"]).lower()
                                              for k in kw) else 1)
            return {"ok": True, "ports": ports}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "ports": []}

    def mav_disconnect(self, params=None):
        try:
            from .mavlink_link import LINK
            return LINK.disconnect()
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def mav_status(self, params=None):
        """Latest telemetry snapshot (heartbeat/GPS/battery/mode/current WP)."""
        try:
            from .mavlink_link import LINK
            return {"ok": True, **LINK.status()}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _mission_items(self):
        """Build MAVLink mission items from the last-built route (or None).

        HOME = where the drone will arm: when connected, use ArduPilot's own home
        (HOME_POSITION) or, failing that, the live GPS position — so the mission's
        home / takeoff / RTL match the vehicle exactly instead of the field
        centroid. Falls back to the field centroid when offline (file export)."""
        if not self._state:
            return None
        from .mavlink_link import build_mission_items, LINK
        s = self._state
        home = s["home"]
        try:
            st = LINK.status()
            if st.get("home_lat") is not None and st.get("home_lon") is not None:
                home = (st["home_lat"], st["home_lon"], 0.0)
            elif (st.get("lat") is not None and st.get("lon") is not None
                  and (st.get("fix_type") or 0) >= 3):
                home = (st["lat"], st["lon"], 0.0)
        except Exception:
            pass
        return build_mission_items(
            home, s["takeoff_alt"], s["waypoints"], s["wp_alt"], s.get("rtl", True),
            speed=s.get("speed", 0))

    def mav_upload_mission(self, params=None):
        """Upload the last-built mission, then read it back to CONFIRM it landed
        on the vehicle (so the user knows the upload truly succeeded)."""
        items = self._mission_items()
        if items is None:
            return {"ok": False, "error": "Спочатку побудуй маршрут."}
        try:
            from .mavlink_link import LINK
            res = LINK.upload_mission(items)
            if not res.get("ok"):
                return res
            # Remember EXACTLY what we put on the vehicle, so a later standalone
            # verify compares against the uploaded mission — not a freshly-rebuilt
            # one whose home/takeoff/RTL may differ if GPS/home arrived meanwhile.
            self._uploaded_items = items
            # Set the auto-mission cruise speed param so the drone actually flies
            # at the chosen speed (DO_CHANGE_SPEED alone is capped by WPNAV_SPEED).
            spd = float(self._state.get("speed", 0) or 0)
            if spd > 0:
                # Copter ≥4.7 renamed the cruise-speed param to WP_SPD (m/s);
                # older firmware uses WPNAV_SPEED (cm/s). Try the new name first.
                ps = LINK.set_param("WP_SPD", spd)            # m/s (no ×100)
                if not ps.get("ok"):
                    ps = LINK.set_param("WPNAV_SPEED", spd * 100.0)   # cm/s legacy
                res["cruise_speed_set"] = ps.get("ok")
            # Round-turn: the frontend passes turn_radius_m = pass-spacing / 2 (0 = off),
            # so the copter flies a rounded U-turn (diameter ≈ pass step) at each pass end.
            # Copter ≥4.7 uses WP_RADIUS_M (m); older firmware WPNAV_RADIUS (cm). No extra
            # waypoints — the autopilot does the arc. Same new-then-legacy try as WP_SPD.
            try:
                trm = float((params or {}).get("turn_radius_m", 0) or 0)
            except (TypeError, ValueError):
                trm = 0.0
            if trm > 0:
                pr = LINK.set_param("WP_RADIUS_M", trm)               # m (Copter ≥4.7)
                if not pr.get("ok"):
                    pr = LINK.set_param("WPNAV_RADIUS", trm * 100.0)  # cm legacy
                res["turn_radius_set"] = pr.get("ok")
            # Додому — камерою вперед: WP_YAW_BEHAVIOR=1 (ніс за курсом і під час
            # RTL; дефолт 2 тримає останній курс — оператор не бачить перешкод).
            py = LINK.set_param("WP_YAW_BEHAVIOR", 1)
            res["yaw_forward_set"] = py.get("ok")
            # Auto read-back verify unless the caller opts out.
            if (params or {}).get("verify", True):
                v = LINK.verify_mission(items)
                res["verify"] = v
                if v.get("ok") and not v.get("verified"):
                    res["verify_warning"] = "Зчитана місія не збігається — перевір."
            return res
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    def mav_download_mission(self, params=None):
        """Read the mission currently stored on the vehicle (raw, for inspection)."""
        try:
            from .mavlink_link import LINK
            return LINK.download_mission()
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    def mav_command(self, params=None):
        """Live flight control: arm/disarm, set mode, start the AUTO mission."""
        try:
            from .mavlink_link import LINK
            action = (params or {}).get("action")
            if action in ("arm", "disarm"):
                want = action == "arm"
                r = LINK.arm(want, force=bool((params or {}).get("force")))
                if not r.get("ok"):
                    return r
                # ACCEPTED != armed — confirm via the HEARTBEAT armed bit.
                import time as _t
                for _ in range(12):
                    _t.sleep(0.2)
                    if LINK.status().get("armed") == want:
                        return {"ok": True}
                why = LINK.status().get("last_text") or "стан моторів не змінився"
                from .mavlink_link import _humanize_reason
                return {"ok": False,
                        "error": f"{'Увімкнення' if want else 'Вимкнення'} моторів не "
                                 f"підтверджено: {_humanize_reason(why)}"}
            if action == "mode":
                return LINK.set_mode((params or {}).get("mode"))
            if action == "start":
                return LINK.mission_start()
            return {"ok": False, "error": f"Невідома дія: {action}"}
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    def mav_verify_mission(self, params=None):
        """Compare the mission on the vehicle to what we UPLOADED.

        Verify against the exact items last uploaded (cached) — rebuilding here
        would use whatever home/GPS arrived since upload and falsely report
        "координати розійшлись". Falls back to a rebuild if nothing was uploaded
        in this session (e.g. checking a mission put there by another GCS)."""
        items = getattr(self, "_uploaded_items", None) or self._mission_items()
        if items is None:
            return {"ok": False, "error": "Спочатку побудуй маршрут."}
        try:
            from .mavlink_link import LINK
            return LINK.verify_mission(items)
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    # ----------------------------------------------------------- photo import
    def import_photo(self, params):
        """Імпорт скріншота агро-ГІС: полігони полів + автоматична прив'язка.

        params: {
            image_b64: str,            # base64 зображення (можна data:-URL)
            region_hint: {lat, lng} | [lat, lon],   # приблизний район (опційно)
            allow_net: bool,           # дозволити тягнути тайли (дефолт True)
        }
        Відповідь — контракт photo_import.import_photo (band/confidence/
        needs_confirm/labels/georef/contours/diag). needs_confirm завжди True —
        фронт зобов'язаний показати підтвердження на мапі перед створенням полів.

        backend.photo_import імпортується ЛІНИВО: він тягне cv2/pytesseract,
        яких немає в Pyodide, а цей файл входить в ENGINE_MODULES і вантажиться
        браузерним движком — top-level import зламав би планувальник у браузері.
        """
        try:
            from . import photo_import
        except Exception as exc:
            return {"ok": False, "band": "red", "needs_confirm": True,
                    "error": "Фото-імпорт недоступний на цьому пристрої "
                             "(потрібен сервер з OpenCV/tesseract): %s" % exc}
        try:
            p = params or {}
            b64 = str(p.get("image_b64") or "")
            if b64.startswith("data:"):        # data:image/...;base64,XXXX
                b64 = b64.split(",", 1)[-1]
            try:
                image_bytes = base64.b64decode(b64)
            except Exception:
                return {"ok": False, "band": "red", "needs_confirm": True,
                        "error": "image_b64 не декодується як base64."}
            # Мережа для тайлів: параметр клієнта + серверний вимикач
            # (FMP_PHOTO_NET=0 — напр. на VPS без вихідного трафіку).
            allow_net = bool(p.get("allow_net", True)) \
                and os.environ.get("FMP_PHOTO_NET") != "0"
            fetch_tile = photo_import.make_tile_fetcher() if allow_net else None
            return photo_import.import_photo(image_bytes, fetch_tile=fetch_tile,
                                             region_hint=p.get("region_hint"))
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    # --------------------------------------------------- project save / load
    def save_project(self, params):
        """Save the field + parameters (+ exclusions) to exports/projects/<name>."""
        try:
            root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            pd = os.path.join(root, "exports", "projects")
            os.makedirs(pd, exist_ok=True)
            raw = (params.get("name") or f"project_{int(time.time())}")
            name = "".join(c for c in raw if c.isalnum() or c in " _-").strip()
            if not name:
                name = f"project_{int(time.time())}"
            project = {
                "type": "field-mission-project", "version": 1,
                "field": params.get("field") or [],
                "params": params.get("params") or {},
                "exclusions": params.get("exclusions") or [],
            }
            path = os.path.join(pd, f"{name}.fmproj.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(project, f, ensure_ascii=False, indent=2)
            return {"ok": True, "path": path}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # --------------------------------------------------------------- exports
    def export(self, fmt):
        """Save the last-built mission as .waypoints or .plan via a save dialog."""
        if not self._state:
            return {"ok": False, "error": "Спочатку побудуй маршрут."}
        # Everything (content build, dialog, write) is guarded so a builder/dialog
        # error returns JSON instead of escaping as a bare HTTP 500.
        try:
            s = self._state
            flights = s.get("flights") or [s["waypoints"]]
            if fmt in ("waypoints", "plan") and len(flights) > 1:
                return self._export_flights(fmt, s, flights)
            if fmt == "waypoints":
                content = to_waypoints(s["home"], s["takeoff_alt"], s["waypoints"],
                                       s["wp_alt"], s["rtl"])
                default = "mission.waypoints"
            elif fmt == "plan":
                content = to_plan(s["home"], s["takeoff_alt"], s["waypoints"],
                                  s["wp_alt"], s["rtl"], cruise_speed=s["speed"])
                default = "mission.plan"
            elif fmt == "fence_plan":
                content = to_geofence_plan(s["contour"], s["home"], s.get("exclusions"))
                default = "field_fence.plan"
            elif fmt == "fence_mp":
                content = to_fence_mp(s["contour"])
                default = "field.fence"
            elif fmt == "contour_geojson":
                content = to_contour_geojson(s["contour"])
                default = "field_contour.geojson"
            else:
                return {"ok": False, "error": f"Невідомий формат: {fmt}"}

            path = self._save_dialog(default)
            if not path:
                return {"ok": False, "cancelled": True}
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(content)
            return {"ok": True, "path": path}
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    def _export_flights(self, fmt, s, flights):
        """Write one mission file per battery flight (mission_f1, _f2, …)."""
        try:
            ext = "waypoints" if fmt == "waypoints" else "plan"
            base = self._save_dialog(f"mission.{ext}")
            if not base:
                return {"ok": False, "cancelled": True}
            root = os.path.splitext(base)[0]
            paths = []
            for i, fl in enumerate(flights, 1):
                if fmt == "waypoints":
                    content = to_waypoints(s["home"], s["takeoff_alt"], fl, s["wp_alt"], s["rtl"])
                else:
                    content = to_plan(s["home"], s["takeoff_alt"], fl, s["wp_alt"], s["rtl"],
                                      cruise_speed=s["speed"])
                p = f"{root}_f{i}.{ext}"
                with open(p, "w", encoding="utf-8", newline="\n") as f:
                    f.write(content)
                paths.append(p)
            name = os.path.basename(root)
            return {"ok": True,
                    "path": f"{len(paths)} файлів: {name}_f1..{len(paths)}.{ext}"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _save_dialog(self, default_name):
        if not self.window:
            # Browser/headless mode: write into the project's exports/ folder.
            root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            exports = os.path.join(root, "exports")
            os.makedirs(exports, exist_ok=True)
            return os.path.join(exports, default_name)
        # pywebview >=5.4 moved the enum to webview.FileDialog.SAVE; older
        # versions expose webview.SAVE_DIALOG. Support both.
        save_mode = getattr(getattr(webview, "FileDialog", None), "SAVE",
                            getattr(webview, "SAVE_DIALOG", 30))
        result = self.window.create_file_dialog(
            save_mode, save_filename=default_name
        )
        if not result:
            return None
        return result if isinstance(result, str) else result[0]
