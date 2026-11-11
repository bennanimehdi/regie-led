# Génère build/icon.png (1024×1024) à partir de logo.png : logo doré centré sur un carré sombre aux coins arrondis.
#   python3 build/make-icon.py        (electron-builder en tire lui-même .icns et .ico)
from PIL import Image, ImageDraw
import os
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024
icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(icon)
m = int(S * 0.04)                                   # légère marge : macOS attend un carré arrondi un peu en retrait
d.rounded_rectangle((m, m, S - m, S - m), radius=int(S * 0.2), fill=(20, 20, 26, 255))
logo = Image.open(os.path.join(root, 'logo.png')).convert('RGBA')
w = int(S * 0.78); h = int(logo.height * w / logo.width)
logo = logo.resize((w, h), Image.LANCZOS)
icon.alpha_composite(logo, ((S - w) // 2, (S - h) // 2))
icon.save(os.path.join(root, 'build', 'icon.png'))
print('build/icon.png', icon.size)
