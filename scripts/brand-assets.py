#!/usr/bin/env python3
"""Build the app's logo, mark and icon files from the RTD reference logo.

Source of truth: docs/brand/RTDLogo.jpg (white sticker logo on brand navy).
Nothing is redrawn: the logo keeps its own pixels, and the dice mark is the
two dice cut from the logo with the same sticker outline put back round them.

    pip install pillow numpy scipy
    python3 scripts/brand-assets.py

Re-run it if the café supplies a better source file (same layout).
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'docs/brand/RTDLogo.jpg'
PUBLIC = ROOT / 'web/public'

NAVY = np.array([18, 63, 104], float)  # #123F68, measured from the reference
WHITE = np.array([255, 255, 255], float)
NAVY_RGB = (18, 63, 104)

LOGO_BOX = (106, 504, 1318, 933)  # sticker logo, with a little margin
DICE_BOX = (190, 470, 530, 720)  # the two d6 above "Roll"
DICE_SEEDS = [(110, 160), (235, 155)]  # a navy pixel on each die face, in DICE_BOX
OUTLINE_PX = 16  # sticker outline width round the dice, measured (best IoU)
SCALE = 3  # work the mark at 3x so edges stay crisp in large icons


def whiteness(img: Image.Image) -> np.ndarray:
    """0 = brand navy, 1 = white, projected on the navy→white axis (removes JPEG tint)."""
    a = np.asarray(img.convert('RGB'), float)
    t = ((a - NAVY) @ (WHITE - NAVY)) / ((WHITE - NAVY) @ (WHITE - NAVY))
    return np.clip(t, 0, 1)


def crisp(t: np.ndarray, gain: float = 3.0) -> np.ndarray:
    """Steepen the edge ramp to drop JPEG speckle while keeping antialiasing."""
    return np.clip((t - 0.5) * gain + 0.5, 0, 1)


def white_knockout(t: np.ndarray) -> Image.Image:
    """White where the logo is white, transparent where it is navy: exact on a navy surface."""
    alpha = (crisp(t) * 255).round().astype(np.uint8)
    h, w = t.shape
    return Image.merge('RGBA', [Image.new('L', (w, h), 255)] * 3 + [Image.fromarray(alpha)])


def dice_mark(src: Image.Image) -> Image.Image:
    crop = src.crop(DICE_BOX)
    big = crop.resize((crop.width * SCALE, crop.height * SCALE), Image.LANCZOS)
    t = crisp(whiteness(big))
    navy = t < 0.5
    labels, _ = ndi.label(navy)
    ids = [labels[y * SCALE, x * SCALE] for x, y in DICE_SEEDS]
    faces = ndi.binary_fill_holes(np.isin(labels, ids))
    dist = ndi.distance_transform_edt(~faces)
    outline = np.clip(OUTLINE_PX * SCALE + 0.5 - dist, 0, 1)
    rgb = np.where(faces[..., None], NAVY + (WHITE - NAVY) * t[..., None], WHITE)
    alpha = np.where(faces, 1.0, outline)
    img = Image.fromarray(np.dstack([rgb, alpha * 255]).round().astype(np.uint8), 'RGBA')
    return img.crop(img.getbbox())


def on_navy(size: int, art: Image.Image, width_frac: float, radius_frac: float = 0.0) -> Image.Image:
    """Centre art on a navy square; radius_frac > 0 gives transparent rounded corners."""
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    bg = Image.new('RGBA', (size, size), NAVY_RGB + (255,))
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), int(size * radius_frac), fill=255)
    canvas.paste(bg, (0, 0), mask)
    w = int(size * width_frac)
    h = round(art.height * w / art.width)
    piece = art.resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(piece, ((size - w) // 2, (size - h) // 2))
    return canvas


def main() -> None:
    src = Image.open(SOURCE).convert('RGB')
    (PUBLIC / 'brand').mkdir(parents=True, exist_ok=True)
    (PUBLIC / 'icons').mkdir(parents=True, exist_ok=True)

    logo = white_knockout(whiteness(src.crop(LOGO_BOX)))
    logo960 = logo.resize((960, round(logo.height * 960 / logo.width)), Image.LANCZOS)
    logo960.save(PUBLIC / 'brand/rtd-logo.webp', quality=92, method=6)

    mark = dice_mark(src)
    mark.resize((480, round(mark.height * 480 / mark.width)), Image.LANCZOS).save(
        PUBLIC / 'brand/rtd-dice-mark.webp', quality=92, method=6)

    # Launcher icons use the dice mark: the full lockup is unreadable at 48px.
    on_navy(512, mark, 0.70, 0.22).save(PUBLIC / 'icons/icon-512.png', optimize=True)
    on_navy(192, mark, 0.70, 0.22).save(PUBLIC / 'icons/icon-192.png', optimize=True)
    # Maskable: full bleed, art inside the 80% safe circle.
    on_navy(512, mark, 0.58).save(PUBLIC / 'icons/maskable-512.png', optimize=True)
    on_navy(192, mark, 0.58).save(PUBLIC / 'icons/maskable-192.png', optimize=True)
    on_navy(180, mark, 0.66).convert('RGB').save(PUBLIC / 'icons/apple-touch-icon.png', optimize=True)
    fav = [on_navy(s, mark, 0.86, 0.2) for s in (16, 32, 48)]
    fav[1].save(PUBLIC / 'icons/favicon-32.png', optimize=True)
    fav[2].save(PUBLIC / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)], append_images=fav[:2])

    # Default share card for links without event artwork: the reference itself, widened.
    og = Image.new('RGBA', (1200, 630), NAVY_RGB + (255,))
    w = 900
    og.alpha_composite(logo.resize((w, round(logo.height * w / logo.width)), Image.LANCZOS),
                       ((1200 - w) // 2, (630 - round(logo.height * w / logo.width)) // 2))
    og.convert('RGB').save(PUBLIC / 'brand/og-default.png', optimize=True)
    print('Brand assets written to', PUBLIC)


if __name__ == '__main__':
    main()
