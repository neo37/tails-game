#!/usr/bin/env python3
"""Перекрашивает текстуру «Танцовщицы» по карте из tools/dancer-outfit.mjs: брюки из джинсовой ткани.

Складки и тени берутся из исходной текстуры (яркость относительно соседних пикселей той же области),
цвет — ровный. Пустые поля атласа рядом с брюками тоже заливаются, чтобы на мипмапах не просвечивала кожа.

Запуск: python3 tools/dancer-outfit.py mask.pgm IN.webp OUT.webp   (нужны numpy и Pillow)
"""
import sys

import numpy as np
from PIL import Image

mask_path, src_path, out_path = sys.argv[1:4]
PANTS = np.array([92, 124, 172], np.float32)        # джинсы, sRGB
mask = np.asarray(Image.open(mask_path))
img = np.asarray(Image.open(src_path).convert('RGB')).astype(np.float32)
mx, mn = img.max(axis=2), img.min(axis=2)
white = ((mx - mn) / np.maximum(mx, 1) < 0.22) & (mx > 150)
pants = mask >= 2

# яркость относительно среднего по самой области (нормированное размытие) — только складки, без «трусов» и «кожи»
lum = img @ np.array([0.299, 0.587, 0.114], np.float32)
def blur(a, r):
    """Двойное блочное размытие (почти гауссово) радиусом r по обеим осям."""
    a = a.astype(np.float32)
    for _ in range(2):
        for ax in (0, 1):
            c =np.cumsum(np.pad(a, [(r + 1, r), (0, 0)] if ax == 0 else [(0, 0), (r + 1, r)], mode='edge'), axis=ax)
            a = ((c[2 * r + 1:] - c[:-2 * r - 1]) if ax == 0 else (c[:, 2 * r + 1:] - c[:, :-2 * r - 1])) / (2 * r + 1)
    return a
# складки считаем отдельно по светлой ткани и по коже — иначе на брюках проступает край белья
local = np.zeros_like(lum)
for cls in (pants & white, pants & ~white):
    m = cls.astype(np.float32)
    loc = blur(lum * m, 4) / np.maximum(blur(m, 4), 1e-3)
    local[cls] = loc[cls]
detail = np.clip(lum / np.maximum(local, 1), 0.6, 1.4)
shade = 0.86 + 0.14 * detail
shade *= 1 + (np.random.default_rng(7).random(mask.shape, np.float32) - 0.5) * 0.06     # лёгкая «ткань»
shade[mask == 3] *= 0.72                                                                # пояс
shade[mask == 4] *= 0.8                                                                 # край штанин
color = PANTS[None, None, :] * shade[..., None]

out = img.copy()
out[pants] = color[pants]

# заливка пустых полей атласа (mask == 0) на 4 пикселя вокруг брюк. Поля растут от всех кусков сразу:
# пиксель, до которого раньше (или одновременно) дотянулся чужой кусок, остаётся как был — иначе синее
# просвечивает по краям футболки и волос
lab = np.where(pants, 2, np.where(mask > 0, 1, 0)).astype(np.uint8)
fill = np.zeros_like(out)
fill[pants] = out[pants]
for _ in range(4):
    acc = np.zeros_like(out)
    cnt = np.zeros(lab.shape, np.float32)
    other = np.zeros(lab.shape, bool)
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        lb = np.roll(lab, (dy, dx), (0, 1))
        g = lb == 2
        acc += np.roll(fill, (dy, dx), (0, 1)) * g[..., None]
        cnt += g
        other |= lb == 1
    empty = lab == 0
    to_other = empty & other
    to_pants = empty & ~other & (cnt > 0)
    fill[to_pants] = acc[to_pants] / cnt[to_pants][:, None]
    lab[to_other] = 1
    lab[to_pants] = 2
gutter = (lab == 2) & ~pants
out[gutter] = fill[gutter]

Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(out_path, 'WEBP', quality=90, method=6)
print('pants px', int(pants.sum()), 'gutter px', int(gutter.sum()), '->', out_path)
