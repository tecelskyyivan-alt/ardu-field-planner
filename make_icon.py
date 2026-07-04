"""Generate icon.ico for the desktop shortcut — a field with a lawnmower route.

Drawn once at high resolution, then saved as a multi-size .ico so Windows shows
a crisp icon at every scale (taskbar, desktop, alt-tab).
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded background tile (dark slate, matches the app panel).
d.rounded_rectangle([8, 8, S - 8, S - 8], radius=46, fill=(26, 34, 30, 255))

# Green field (slightly tilted square).
field = [(56, 70), (210, 52), (200, 196), (46, 210)]
d.polygon(field, fill=(60, 132, 72, 255), outline=(96, 196, 120, 255))

# Orange lawnmower "snake" route across the field.
route = [
    (70, 96), (188, 84),
    (190, 110), (72, 122),
    (74, 148), (192, 136),
    (194, 162), (76, 174),
]
d.line(route, fill=(255, 140, 45, 255), width=9, joint="curve")
# Start (green) and finish (red) dots.
d.ellipse([62, 88, 80, 106], fill=(120, 230, 170, 255))
d.ellipse([186, 166, 204, 184], fill=(255, 110, 100, 255))

sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
out = os.path.join(HERE, "icon.ico")
img.save(out, format="ICO", sizes=sizes)
print("wrote", out)
