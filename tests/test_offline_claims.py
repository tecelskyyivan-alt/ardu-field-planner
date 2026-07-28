"""What the README promises about working offline must match what the app fetches.

FMP is sold as offline-first and is used in fields with no signal, so every external
host it contacts is a thing that silently stops working out there. The README used to
name one — the satellite map. Audited 2026-07-29, the shipped frontend contacts three,
and the one nobody had written down is a SAFETY feature: automatic power-line (ЛЕП)
detection queries OpenStreetMap via Overpass, so with no signal no pylons are found and
the operator gets no warning that the search silently returned nothing.

This test is an allowlist, not a string-match on the prose. Adding a new external host
fails it, and the fix is to decide whether the feature may depend on the network and to
say so in the README where an operator will read it before driving out.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
APP_JS = ROOT / "web-stable" / "app.js"
README = ROOT / "README.md"

#: host -> what breaks without it. Every entry must also be documented in the README.
ALLOWED_HOSTS = {
    "server.arcgisonline.com": "satellite basemap tiles (pre-cacheable per field)",
    "api.open-meteo.com": "elevation grid for the terrain altitude-limit zones",
    "overpass-api.de": "OSM power-line search (SAFETY: no ЛЕП found offline)",
    "overpass.kumi.systems": "OSM power-line search, second mirror",
}

#: Not fetched — an XML namespace identifier written into exported KML.
NOT_A_FETCH = {"www.opengis.net"}

_URL = re.compile(r"https?://([A-Za-z0-9.-]+)")


def hosts_in_app_js() -> set[str]:
    return {h for h in _URL.findall(APP_JS.read_text(encoding="utf-8"))} - NOT_A_FETCH


def test_no_undocumented_external_host():
    found = hosts_in_app_js()
    new = found - set(ALLOWED_HOSTS)
    assert not new, (
        f"the frontend contacts host(s) nobody has accounted for: {sorted(new)}. "
        "Offline-first means every one of these is a feature that dies in a field with "
        "no signal — add it to ALLOWED_HOSTS and to the README's offline table.")


def test_the_allowlist_has_not_gone_stale():
    """A host that is no longer used should leave the list, or it misleads."""
    found = hosts_in_app_js()
    gone = set(ALLOWED_HOSTS) - found
    assert not gone, (
        f"ALLOWED_HOSTS still lists {sorted(gone)}, which the app no longer contacts")


@pytest.mark.parametrize("host", sorted(ALLOWED_HOSTS))
def test_every_networked_feature_is_named_in_the_readme(host):
    """An operator must be able to learn this before leaving, not in the field."""
    text = README.read_text(encoding="utf-8")
    assert host in text, (
        f"{host} is contacted by the app but never named in the README "
        f"({ALLOWED_HOSTS[host]})")


def test_readme_does_not_advertise_the_removed_route_anchor():
    """app.js: 'no route anchor any more' / 'intentionally NOT restored'.

    The README claimed a start/finish anchor feature for some time after the app
    dropped it, which is the kind of overclaim a technical reader checks and finds.
    """
    app = APP_JS.read_text(encoding="utf-8")
    assert "no route anchor any more" in app, (
        "the anchor may have come back — if so, restore the README bullet and delete "
        "this test rather than working around it")
    readme = README.read_text(encoding="utf-8")
    assert "Start/finish anchor" not in readme, (
        "the README advertises a start/finish anchor the app removed")


def test_readme_flags_sortie_splitting_as_engine_only():
    """build_route honours split.mode; the shipped app never sends it.

    Verified: the params object in app.js carries no `split` and no `battery_min`, and
    the sector-line drawing tool is disabled (`polyline: false`), so `res.flights` is
    always 1. The engine capability is real and tested — the UI path is not there.
    """
    app = APP_JS.read_text(encoding="utf-8")
    assert "battery_min" not in app, (
        "the app now sends battery_min — wire it up in the README's feature list and "
        "drop the 'engine only' caveat")
    readme = README.read_text(encoding="utf-8")
    assert "Engine only, no UI yet" in readme, (
        "the README advertises sortie splitting without saying the app cannot request it")
