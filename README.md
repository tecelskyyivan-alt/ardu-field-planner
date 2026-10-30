<p align="center"><img src="docs/banner.jpg" alt="Field Mission Planner — spray routes for ArduPilot drones"></p>

<p align="center"><b>English</b> · <a href="README.uk.md">Українська</a></p>

<p align="center"><b>Draw the field on your phone, fly it. Free, offline, no DJI lock-in.</b></p>

<p align="center">
  <a href="https://tecelskyyivan-alt.github.io/ardu-field-planner/"><img src="https://img.shields.io/badge/▶_Open_in_browser-no_install-2ea44f?style=for-the-badge" alt="open"></a>
  <a href="https://github.com/tecelskyyivan-alt/ardu-field-planner/releases/latest"><img src="https://img.shields.io/github/v/release/tecelskyyivan-alt/ardu-field-planner?label=Android%20APK&style=for-the-badge" alt="apk"></a>
</p>

## Who it is for

You fly a **spraying drone on ArduPilot** (Pixhawk / Cube / any ArduCopter flight controller) and
you are tired of:

- **Mission Planner's Auto Grid** — built for mapping, not spraying: no cut-outs, no field geofence;
- **stitching paths by hand** around trees, ponds and power-line poles;
- **carrying a laptop** to the field;
- **DJI / XAG planners** that only work with their own hardware and cloud.

FMP plans the spray route on the phone you already have and flies it over MAVLink.

## What it does

![The real app: a 77 ha field between windbreaks, route ready to fly](docs/screenshot.jpg)
<sub>The real app in the browser — a 77 ha field between windbreaks, route built and ready to upload.</sub>

**Plan**
- Draw the field on a satellite map; drag vertices and the route rebuilds live.
- **Cut-outs** for trees, ponds, buildings — the route goes **around** them and they go into the geofence.
- **Power lines found automatically** from OpenStreetMap and cut out of the route (or draw them by hand).
- Pass spacing = your swath width; pass angle or **auto-angle for the shortest flight**; edge margin; rounded U-turns.
- **Terrain zones** — see where the field rises above your safe altitude before you take off.
- **Import a whole field database from KML**, pick a parcel by tapping, merge neighbours into one field.
- Realistic mission time: take-off, transit, passes, turns, return and landing.

**Fly**
- Upload over **USB cable, WiFi (ELRS backpack) or Bluetooth**, with read-back check of every waypoint.
- Live telemetry, ARM / mode / **AUTO → pause → resume → RTL** from the app.
- **Resume after a battery swap** from where the drone stopped.
- **GPS jamming / spoofing alarm** — sound and vibration when satellites or position jump.
- **Phone → drone without a laptop**: the open ELRS backpack firmware in every release lets a phone browser talk MAVLink directly.
- No-GPS mode (VIO): home is a point on the map.

**Keep records**
- Every AUTO flight is logged offline; plan-vs-actual calibrates time estimates to *your* drone.
- Work records with hectares — export to CSV.
- Export `.waypoints` / `.plan` / geofence `.fence` / `.geojson` / KML for Mission Planner or QGroundControl.

Interface in **English and Ukrainian**.

## How it compares

| | **FMP** | Mission Planner / QGC | DJI Agras / XAG |
|---|---|---|---|
| Spray route around cut-outs | ✅ | ❌ (mapping grid) | ✅ |
| Power lines cut out automatically | ✅ (OSM) | ❌ | sensors in flight |
| Geofence from the field outline | ✅ one step | manual | ✅ |
| Runs on a phone, offline | ✅ | desktop (MP) | own remote only |
| Works with ArduPilot | ✅ | ✅ | ❌ |
| GPS jamming / spoofing alarm | ✅ | ❌ | not published |
| Price | **free, open source** | free | price of the drone |

What FMP does **not** do (yet): terrain following, variable-rate application maps,
obstacle avoidance in flight — those need sensors or are on the roadmap.
**Engine only, no UI yet:** splitting a big field into several sorties and spray-liquid /
tank-refill planning — the route engine can do both, the app does not ask for them yet.

## Get started in 3 minutes

1. **[Open the app in your browser](https://tecelskyyivan-alt.github.io/ardu-field-planner/)** —
   works on PC, Android and iPhone; "Install" it as an app to use offline.
   Or install the **[Android APK](https://github.com/tecelskyyivan-alt/ardu-field-planner/releases/latest)**
   (allow install from unknown sources; updates install over the old version, your fields stay).
2. Draw your field, add cut-outs, set swath width and altitude — the route appears.
3. **Export** the mission for Mission Planner / QGC, or **connect** and upload straight to the drone.

Before driving to a field with no signal: press **"Save area map offline"**. Planning works
without internet; the satellite map, terrain zones and automatic power-line search need it once.

| needs internet | without it |
|---|---|
| satellite map (`server.arcgisonline.com`) | pre-cache the area — then it works offline |
| terrain zones (`api.open-meteo.com`) | no terrain zones; the route still builds |
| **automatic power-line search** (OpenStreetMap: `overpass-api.de`, `overpass.kumi.systems`) | **no lines found — draw them by hand** |
| bug report: «Create issue» and the backpack-firmware download (`github.com`) | button only; nothing in the field depends on it |
| sending the app log to the developer (`script.google.com`) | button only; the Android app queues the log and sends it later |

## Platforms

| | |
|---|---|
| 🌐 **Browser** (PC, Android, iPhone) | [open now](https://tecelskyyivan-alt.github.io/ardu-field-planner/), installable, works offline |
| 📱 **Android** | [APK](https://github.com/tecelskyyivan-alt/ardu-field-planner/releases/latest) — USB to the flight controller, WiFi, Bluetooth |
| 🍎 **iPhone** | browser version + ELRS backpack over WiFi |
| 🖥️ **Windows / macOS desktop** | from source — see [DEVELOPMENT.md](docs/DEVELOPMENT.md) |

## ⚠️ Safety

This software plans and uploads missions for **real spraying drones**. A mistake can crash the
aircraft, spray the wrong area, or injure people and damage crops. It comes **with no warranty**
([LICENSE](LICENSE)). **You are the pilot-in-command:** check every mission before flight, keep
visual line-of-sight and manual override, and follow your local drone **and pesticide** rules.

## Tell me how it works for you

I'm an aviation design engineer and I build this for real spraying work. One answer helps more
than a star — **what part of preparing a spray mission takes you the longest?**

[Discussions](https://github.com/tecelskyyivan-alt/ardu-field-planner/discussions) ·
[Report a problem](https://github.com/tecelskyyivan-alt/ardu-field-planner/issues/new/choose) ·
**teselskyy@gmail.com**

Drone model and field size help, but a one-line answer is already useful.

---

[![tests](https://github.com/tecelskyyivan-alt/ardu-field-planner/actions/workflows/tests.yml/badge.svg)](https://github.com/tecelskyyivan-alt/ardu-field-planner/actions/workflows/tests.yml) ·
[Changelog / releases](https://github.com/tecelskyyivan-alt/ardu-field-planner/releases) ·
[Contributing](CONTRIBUTING.md) ·
[Development](docs/DEVELOPMENT.md) ·
[ELRS backpack setup](docs/elrs-backpack-browser.md) ·
[Security](SECURITY.md) ·
[Third-party](THIRD_PARTY.md) ·
License **GPLv3**
