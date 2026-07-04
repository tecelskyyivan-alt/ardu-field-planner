"""Find kadastr.live's tile/API endpoint by loading the real map in a browser
and capturing its network requests."""
import re
import sys

from playwright.sync_api import sync_playwright

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
INTEREST = re.compile(r"\.pbf|mvt|/api/|/tiles?/|geoserver|martin|tegola|parcel|\.json|wfs|wms|\{z\}", re.I)


SITES = [
    "https://map.land.gov.ua/",
    "https://e.land.gov.ua/",
    "https://kadastrova-karta.com/",
    "https://e-construction.gov.ua/map/main",
    "https://nsdi.land.gov.ua/",
]


def probe(p, url):
    seen, responses = [], {}
    ctx = p.chromium.launch(headless=True).new_context(
        user_agent=UA, viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    page.on("request", lambda r: seen.append((r.resource_type, r.method, r.url)))
    page.on("response", lambda r: responses.__setitem__(r.url, r.status))
    err = None
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=40000)
        page.wait_for_timeout(7000)
    except Exception as exc:
        err = str(exc).splitlines()[0]
    title = page.title()
    ctx.browser.close()
    interesting = []
    for rt, method, u in seen:
        if INTEREST.search(u) and u not in [x[2] for x in interesting]:
            interesting.append((rt, method, u))
    return {"url": url, "err": err, "title": title, "reqs": len(seen),
            "endpoints": interesting, "responses": responses}


def main():
    with sync_playwright() as p:
        for url in SITES:
            r = probe(p, url)
            print(f"\n==== {url} ====")
            print(f"  title={r['title'][:60]!r} reqs={r['reqs']}" + (f" ERR={r['err']}" if r['err'] else ""))
            for rt, method, u in r["endpoints"][:12]:
                print(f"   [{rt}/{method}] {r['responses'].get(u,'?')} {u[:130]}")


if __name__ == "__main__":
    main()
