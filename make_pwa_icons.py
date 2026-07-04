"""Generate PWA icons (web/icon-192.png, web/icon-512.png) — same field+route art
as the desktop icon, but full-bleed on the app background so Android can mask it
to any shape (round/squircle) without showing transparent corners.
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")

# Draw the art on a 256 transparent tile (reused from make_icon.py).
art = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
d = ImageDraw.Draw(art)
field = [(56, 70), (210, 52), (200, 196), (46, 210)]
d.polygon(field, fill=(60, 132, 72, 255), outline=(96, 196, 120, 255))
route = [
    (70, 96), (188, 84), (190, 110), (72, 122),
    (74, 148), (192, 136), (194, 162), (76, 174),
]
d.line(route, fill=(255, 140, 45, 255), width=9, joint="curve")
d.ellipse([62, 88, 80, 106], fill=(120, 230, 170, 255))
d.ellipse([186, 166, 204, 184], fill=(255, 110, 100, 255))

# Full-bleed 512 canvas in the app background colour (#0e1419), art centred in
# the maskable safe zone (~70%).
canvas = Image.new("RGBA", (512, 512), (14, 20, 25, 255))
inner = art.resize((360, 360), Image.LANCZOS)
canvas.alpha_composite(inner, (76, 76))

for size in (192, 512):
    out = os.path.join(WEB, f"icon-{size}.png")
    canvas.resize((size, size), Image.LANCZOS).convert("RGBA").save(out, format="PNG")
    print("wrote", out)
