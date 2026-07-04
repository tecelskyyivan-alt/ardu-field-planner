"""Build a SQLite + R-tree spatial index from all NASA Harvest oblast shapefiles
in data/*.zip. Parallel across CPU cores; geometry simplified (~3-4 m) and stored
as WKB. Scales to all-Ukraine (5M+ fields) with low query RAM.

Run:  python build_index.py
"""
import glob
import os
import shutil
import sqlite3
import subprocess
import tempfile
import time
from multiprocessing import Pool

import shapefile  # pyshp
from shapely.geometry import Polygon

SEVENZIP = "7z"   # handles Deflate64 zips
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_FINAL = os.path.join(DATA, "fields.sqlite")
WORKERS = 6


def _build_one(zp):
    """Worker: extract + simplify one oblast into data/_part_<oblast>.sqlite."""
    oblast = os.path.basename(zp).split("_")[0]
    part = os.path.join(DATA, f"_part_{oblast}.sqlite")
    if os.path.exists(part):
        os.remove(part)
    tmp = tempfile.mkdtemp()
    n = 0
    try:
        subprocess.run([SEVENZIP, "x", "-y", "-bso0", "-bsp0", f"-o{tmp}", zp],
                       check=True, capture_output=True)
        shps = glob.glob(os.path.join(tmp, "**", "*.shp"), recursive=True)
        if not shps:
            return (oblast, 0, None)
        con = sqlite3.connect(part)
        con.execute("PRAGMA journal_mode=OFF")
        con.execute("PRAGMA synchronous=OFF")
        con.execute("CREATE TABLE rows(area REAL, oblast TEXT, wkb BLOB, "
                    "minx REAL, maxx REAL, miny REAL, maxy REAL)")
        sf = shapefile.Reader(shps[0])
        names = [f[0] for f in sf.fields[1:]]
        ai = names.index("Area_ha") if "Area_ha" in names else None
        batch = []
        for sr in sf.iterShapeRecords():
            shape = sr.shape
            if not shape.points:
                continue
            parts = list(shape.parts) + [len(shape.points)]
            ring = shape.points[parts[0]:parts[1]]
            if len(ring) < 4:
                continue
            try:
                poly = Polygon(ring)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                poly = poly.simplify(0.00004, preserve_topology=True)
                if poly.is_empty or poly.area <= 0 or poly.geom_type != "Polygon":
                    continue
            except Exception:
                continue
            n += 1
            area = None
            if ai is not None:
                try:
                    area = float(sr.record[ai])
                except Exception:
                    area = None
            mnx, mny, mxx, mxy = poly.bounds
            batch.append((area, oblast, poly.wkb, mnx, mxx, mny, mxy))
            if len(batch) >= 5000:
                con.executemany("INSERT INTO rows VALUES(?,?,?,?,?,?,?)", batch)
                batch = []
        if batch:
            con.executemany("INSERT INTO rows VALUES(?,?,?,?,?,?,?)", batch)
        con.commit()
        con.close()
        return (oblast, n, part)
    except Exception as exc:
        return (oblast, -1, f"ERR {exc}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def build():
    db = DB_FINAL + ".building"
    if os.path.exists(db):
        os.remove(db)
    zips = sorted(glob.glob(os.path.join(DATA, "*.zip")))
    print(f"{len(zips)} oblasts, {WORKERS} workers", flush=True)
    t0 = time.perf_counter()

    results = []
    with Pool(WORKERS) as pool:
        for oblast, n, part in pool.imap_unordered(_build_one, zips):
            results.append((oblast, n, part))
            print(f"  built {oblast}: {n} fields", flush=True)

    print("merging…", flush=True)
    con = sqlite3.connect(db)
    con.execute("PRAGMA journal_mode=OFF")
    con.execute("PRAGMA synchronous=OFF")
    con.execute("CREATE TABLE fields(id INTEGER PRIMARY KEY, area_ha REAL, oblast TEXT, wkb BLOB)")
    con.execute("CREATE VIRTUAL TABLE fields_rtree USING rtree(id, minx, maxx, miny, maxy)")
    fid = 0
    for oblast, n, part in results:
        if not part or not os.path.exists(part):
            continue
        pc = sqlite3.connect(part)
        bf, br = [], []
        for area, ob, wkb, mnx, mxx, mny, mxy in pc.execute(
                "SELECT area, oblast, wkb, minx, maxx, miny, maxy FROM rows"):
            fid += 1
            bf.append((fid, area, ob, wkb))
            br.append((fid, mnx, mxx, mny, mxy))
            if len(bf) >= 10000:
                con.executemany("INSERT INTO fields VALUES(?,?,?,?)", bf)
                con.executemany("INSERT INTO fields_rtree VALUES(?,?,?,?,?)", br)
                bf, br = [], []
        if bf:
            con.executemany("INSERT INTO fields VALUES(?,?,?,?)", bf)
            con.executemany("INSERT INTO fields_rtree VALUES(?,?,?,?,?)", br)
        con.commit()
        pc.close()
        os.remove(part)
        print(f"  merged {oblast} (total {fid})", flush=True)

    con.commit()
    con.close()
    if os.path.exists(DB_FINAL):
        os.remove(DB_FINAL)
    os.replace(db, DB_FINAL)
    print(f"DONE: {fid} fields, DB {os.path.getsize(DB_FINAL)/1048576:.0f} MB "
          f"({time.perf_counter()-t0:.0f}s)", flush=True)


if __name__ == "__main__":
    build()
