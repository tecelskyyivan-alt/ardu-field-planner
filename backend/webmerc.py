"""Web-Mercator (EPSG:3857) math for the photo-georeferencing pipeline.

Used to map pixel coordinates of an agro-GIS screenshot onto real-world
coordinates: the screenshot is a north-up web-mercator basemap, so pixel ->
world is a similarity transform (translation + rotation + uniform scale)
in mercator metres, plus the y-axis flip (pixel y grows down, mercator y
grows up).

Pure stdlib (math/cmath) — no numpy needed, safe to import anywhere.
"""
import cmath
import math

R_MERC = 6378137.0                      # WGS84 сфера, як у EPSG:3857
MERC_MAX = math.pi * R_MERC             # 20037508.342789244 m — межа світу
MAX_LAT = 85.05112877980659             # широта, де мерк. y == MERC_MAX


def lonlat_to_merc(lon, lat):
    """(lon, lat) градуси -> (x, y) метри EPSG:3857."""
    x = math.radians(lon) * R_MERC
    # asinh-форма еквівалентна ln(tan(pi/4 + lat/2)), але точна біля екватора
    y = math.asinh(math.tan(math.radians(lat))) * R_MERC
    return x, y


def merc_to_lonlat(x, y):
    """(x, y) метри EPSG:3857 -> (lon, lat) градуси."""
    lon = math.degrees(x / R_MERC)
    lat = math.degrees(2 * math.atan(math.exp(y / R_MERC)) - math.pi / 2)
    return lon, lat


def tile_xyz_of(lon, lat, z):
    """Slippy-tile (x, y, z), у якому лежить точка (lon, lat) на зумі z."""
    n = 1 << z
    xt = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    yt = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    # На краях світу індекс може вилізти на 1 за межу — затискаємо.
    xt = max(0, min(n - 1, xt))
    yt = max(0, min(n - 1, yt))
    return xt, yt, z


def tile_bounds_merc(x, y, z):
    """Межі slippy-тайла (x, y, z) у метрах 3857: (xmin, ymin, xmax, ymax).

    Пам'ятаємо: тайловий y росте вниз (на південь), мерк. y — вгору,
    тому ymax відповідає верхньому краю тайла (меншому тайловому y).
    """
    n = 1 << z
    tile_m = 2 * MERC_MAX / n           # розмір тайла в метрах
    xmin = -MERC_MAX + x * tile_m
    ymax = MERC_MAX - y * tile_m
    return xmin, ymax - tile_m, xmin + tile_m, ymax


def meters_per_pixel(lat, z, tile_px=256):
    """Роздільність базової карти (м/піксель) на широті lat і зумі z."""
    return (2 * MERC_MAX * math.cos(math.radians(lat))) / (tile_px * (1 << z))


def fit_similarity(px_pts, merc_pts):
    """Підганяє подібність (зсув + поворот + один масштаб) піксель -> 3857.

    Модель (з урахуванням y-фліпа — піксельний y росте вниз):

        merc = scale * R(rot_rad) @ (px, -py) + (tx, ty)

    У комплексній формі: m = a * p + b, де p = px - i*py, a = scale*e^{i*rot},
    b = tx + i*ty. Least-squares розв'язок по a, b замкнений і однаковий для
    2 точок (точний) і 3+ (umeyama-стиль, без відбиття — det завжди > 0).

    px_pts, merc_pts: списки (x, y) однакової довжини, >= 2 точок, без збігів.
    Повертає dict {scale, rot_rad, tx, ty, rmse_m}. rmse_m — чесний залишок
    у метрах по контрольних точках; калібрований downstream-гейт довіри
    має дивитись саме на нього.
    """
    if len(px_pts) != len(merc_pts):
        raise ValueError("px_pts і merc_pts мають бути однакової довжини")
    if len(px_pts) < 2:
        raise ValueError("потрібно щонайменше 2 пари точок")

    ps = [complex(x, -y) for (x, y) in px_pts]      # y-flip тут
    ms = [complex(x, y) for (x, y) in merc_pts]
    n = len(ps)
    p_mean = sum(ps) / n
    m_mean = sum(ms) / n

    num = sum((m - m_mean) * (p - p_mean).conjugate() for p, m in zip(ps, ms))
    den = sum(abs(p - p_mean) ** 2 for p in ps)
    if den == 0:
        raise ValueError("піксельні точки збігаються — подібність не визначена")
    a = num / den
    if a == 0:
        raise ValueError("вироджена конфігурація точок")
    b = m_mean - a * p_mean

    resid2 = sum(abs(a * p + b - m) ** 2 for p, m in zip(ps, ms))
    return {
        "scale": abs(a),
        "rot_rad": cmath.phase(a),
        "tx": b.real,
        "ty": b.imag,
        "rmse_m": math.sqrt(resid2 / n),
    }


def apply_similarity(t, px_pts):
    """Застосовує transform з fit_similarity до пікселів -> [(mx, my), ...]."""
    a = t["scale"] * cmath.exp(1j * t["rot_rad"])
    b = complex(t["tx"], t["ty"])
    out = []
    for (x, y) in px_pts:
        m = a * complex(x, -y) + b
        out.append((m.real, m.imag))
    return out


def px_ring_to_lonlat(t, ring_px):
    """Піксельне кільце полігона -> [(lon, lat), ...] через transform t."""
    return [merc_to_lonlat(mx, my) for (mx, my) in apply_similarity(t, ring_px)]
