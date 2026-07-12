# Security & Safety Policy

## ⚠️ Operational safety
This is **drone-control software** that plans and uploads spray missions to real
aircraft. Misuse or a bug can crash the drone, spray the wrong area, or cause injury
and crop/property damage. Always review every mission in Mission Planner / QGroundControl,
keep visual line-of-sight and a manual override, and follow local drone and pesticide
regulations. Provided **with no warranty** (GPLv3). Use at your own risk.

## Reporting a vulnerability
Please report security issues **privately** via GitHub → *Security* →
*Report a vulnerability* (private advisory), not as a public issue. We aim to respond
within a reasonable time and will credit reporters unless they prefer otherwise.

## Secrets & self-hosted server
The optional diagnostic-log upload and APK self-update features are **disabled by
default** (empty server URL) so a public build never sends data anywhere. If you enable
them for your own deployment:
- Put the server URL and any basic-auth credentials in a **gitignored** config /
  build property — **never commit them**.
- Release signing reads the keystore + passwords from a gitignored `keystore.properties`;
  without it the build falls back to a debug key. **Never commit keystores, `*.keystore`,
  `keystore.properties`, or passwords.**

## Data & privacy
The app is offline-first: fields and settings are stored **on the device**
(localStorage / IndexedDB). Map/elevation providers receive only the map-area
coordinates while online. No ads, no tracking, no data selling.
