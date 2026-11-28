#!/usr/bin/env python3
"""Bakes hud/fonts/<name>.json atlases (the per-glyph format hud_text.js loads:
{"source","size","cellHeight","baseline","glyphs":{ch:{x,y,w,h,ox,advance}},
"width","height","alpha": base64}).

Each glyph is stored as a cellHeight-tall slice drawn at the baseline, with
`ox` the bitmap offset from the pen position. Rows pack glyphs left-to-right
up to `width` px.

  python bake_hud_fonts.py
  FONTDIR=preview/fonts python bake_hud_fonts.py rc_bold
"""
import base64, json, os, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTDIR = os.environ.get('FONTDIR', os.path.join(HERE, '..', '..', 'preview', 'fonts'))
OUT = os.path.join(HERE, '..', '..', 'apps', 'vclusters', 'hud', 'fonts')
WIDTH = 1024
DRAWX = 8          # glyphs are drawn this far into their temp cell
MARGIN = 4         # alpha margin kept around the ink on each side

CHARSET = ''.join(chr(c) for c in range(32, 127)) + '°–—'

# name: (ttf file, variation axes or None, pixel size)
FAMILIES = {
    'rc_bold': ('RobotoCondensed.ttf', [700], 29),
    'rc_reg':  ('RobotoCondensed.ttf', [400], 24),
    'euro_gear':  ('EurostileExtendedBlack.woff', None, 100, 'PRNDSM0123456789 '),
    'euro_speed': ('EurostileExtendedBlack.woff', None, 64, '0123456789 '),
    'sq_gear':    ('Square721BT-BoldExtended.ttf', None, 100, 'PRNDSM0123456789 '),
    'sq_speed':   ('Square721BT-BoldExtended.ttf', None, 64, '0123456789 '),
}


def bake(name, ttf, var, size, charset=None):
    global CHARSET
    full, CHARSET = CHARSET, charset or CHARSET
    try:
        return _bake(name, ttf, var, size)
    finally:
        CHARSET = full


def _bake(name, ttf, var, size):
    font = ImageFont.truetype(os.path.join(FONTDIR, ttf), size)
    if var:
        font.set_variation_by_axes(list(var))
    asc, desc = font.getmetrics()
    baseline, cell_h = asc, asc + desc
    cells = []
    for ch in CHARSET:
        tmp = Image.new('L', (256, cell_h), 0)
        ImageDraw.Draw(tmp).text((DRAWX, baseline), ch, font=font, fill=255, anchor='ls')
        box = tmp.getbbox()
        if not box:
            adv = font.getlength(ch)
            cells.append((ch, None, {'x': 0, 'y': 0, 'w': 0, 'h': 0, 'ox': 0, 'advance': int(round(adv))}))
            continue
        l, t, r, b = box
        x0 = max(0, l - MARGIN)
        x1 = min(tmp.width, r + MARGIN)
        adv = font.getlength(ch)
        cells.append((ch, tmp.crop((x0, 0, x1, cell_h)), {
            'x': 0, 'y': 0, 'w': x1 - x0, 'h': cell_h, 'ox': x0 - DRAWX, 'advance': int(round(adv)),
        }))
    rows = [[]]
    x = 0
    for cell in cells:
        w = cell[2]['w']
        if x + w > WIDTH and rows[-1]:
            rows.append([])
            x = 0
        rows[-1].append((cell, x))
        x += w
    height = len(rows) * cell_h
    atlas = Image.new('L', (WIDTH, height), 0)
    glyphs = {}
    for ri, rcells in enumerate(rows):
        for (ch, img, m), gx in rcells:
            if img is not None:
                atlas.paste(img, (gx, ri * cell_h))
                m['x'], m['y'] = gx, ri * cell_h
            glyphs[ch] = m
    out = {'source': ttf, 'size': size, 'cellHeight': cell_h, 'baseline': baseline,
           'glyphs': glyphs, 'width': WIDTH, 'height': height,
           'alpha': base64.b64encode(atlas.tobytes()).decode('ascii')}
    path = os.path.join(OUT, name + '.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print('%s: size %d, cellH %d, baseline %d, %d rows -> %s (%d KB)' %
          (name, size, cell_h, baseline, len(rows), path, os.path.getsize(path) // 1024))


def main():
    names = sys.argv[1:] or list(FAMILIES)
    os.makedirs(OUT, exist_ok=True)
    for n in names:
        bake(n, *FAMILIES[n])


if __name__ == '__main__':
    main()
