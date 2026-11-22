#!/usr/bin/env python3
"""qrlog_decode.py - turn photos of an app's QR log (Settings > QR log, kit/runtime/qrlog.js) back into the log.

    pip install zxing-cpp pillow
    python3 kit/tools/qrlog_decode.py photo1.jpg photo2.jpg ...   (or a folder of photos)
    python3 kit/tools/qrlog_decode.py scanned-code.txt

Prints the log in time order (page 1 holds the newest lines, so it comes last) (a photo with several codes, or the same page twice, is fine). A page that
didn't read is named, so you can ask for that photo again. A scanner's copied MGULOG3 text may also be saved to a .txt file and decoded.

A code is either the older binary MGULOG2 format or scanner-friendly ASCII MGULOG3 text, followed by the page's log lines
compressed with raw deflate and the preset dictionary kit/runtime/qrlog-dict-<n>.txt (d0: none). In a page, a time
after the first is "+<seconds>" since the line before; the decoder writes hh:mm:ss again.
"""
import os
import sys
import zlib

try:
    import zxingcpp
    from PIL import Image, ImageFilter, ImageOps
except ImportError:
    zxingcpp = None

MAGIC = b'MGULOG2 '
MAGIC_TEXT = b'MGULOG3:'
BASE45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'
DICTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'runtime')


def dictionary(n):
    if n == 0:
        return None
    with open(os.path.join(DICTS, 'qrlog-dict-%d.txt' % n), 'rb') as f:
        return f.read()


def abs_times(text):
    """'+<seconds> ' after the line before -> hh:mm:ss again."""
    out, last = [], None
    for line in text.split('\n'):
        head, _, rest = line.partition(' ')
        if len(head) == 8 and head[2] == ':' and head[5] == ':' and head.replace(':', '').isdigit():
            h, m, s = (int(x) for x in head.split(':'))
            last = h * 3600 + m * 60 + s
        elif head[:1] == '+' and head[1:].isdigit() and last is not None:
            last += int(head[1:])
            line = '%02d:%02d:%02d %s' % (last // 3600 % 24, last // 60 % 60, last % 60, rest)
        out.append(line)
    return '\n'.join(out)


def base45_decode(text):
    """Decode the Base45 payload used by the scanner-friendly MGULOG3 QR text."""
    values = {c: i for i, c in enumerate(BASE45)}
    if len(text) % 3 == 1:
        raise ValueError('bad Base45 length')
    out = bytearray()
    i = 0
    while i < len(text):
        count = 2 if len(text) - i == 2 else 3
        n = values[text[i]] + values[text[i + 1]] * 45
        if count == 3:
            n += values[text[i + 2]] * 2025
        if n > (255 if count == 2 else 65535):
            raise ValueError('bad Base45 value')
        if count == 2:
            out.append(n)
        else:
            out.extend((n // 256, n % 256))
        i += count
    return bytes(out)


def codes(path):
    """The QR codes' bytes in one photo (as is, then cleaned up: grey with more contrast, sharpened, bigger)."""
    with open(path, 'rb') as f:
        raw = f.read().strip()
    if raw.startswith(MAGIC_TEXT) or raw.startswith(MAGIC):
        return [raw]
    if zxingcpp is None:
        raise RuntimeError('photos need: pip install zxing-cpp pillow')
    img = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    grey = ImageOps.autocontrast(img.convert('L'), cutoff=1)
    sharp = grey.filter(ImageFilter.UnsharpMask(radius=3, percent=200, threshold=0))
    big = sharp.resize((sharp.width * 2, sharp.height * 2), Image.LANCZOS)
    found = []
    for im in (img, grey, sharp, big):
        for r in zxingcpp.read_barcodes(im, formats=zxingcpp.BarcodeFormat.QRCode):
            if r.valid and r.bytes not in found:
                found.append(bytes(r.bytes))
        if found:
            break
    return found


def page(data):
    """A code's bytes -> (app version, page, pages, text) or None if it isn't a QR log code."""
    if data.startswith(MAGIC_TEXT):
        try:
            fields = data.decode('ascii').split(':', 5)
            if len(fields) != 6 or not fields[5].endswith('0'):
                return None
            _, d, app, version, page_no, payload = fields
            n, of = (int(x) for x in page_no.split('/'))
            compressed = base45_decode(payload[:-1])
            preset = dictionary(int(d[1:]))
            z = zlib.decompressobj(-15, zdict=preset) if preset else zlib.decompressobj(-15)
            text = abs_times((z.decompress(compressed) + z.flush()).decode('utf8', 'replace'))
            return app + ' ' + version, n, of, text
        except (ValueError, IndexError, KeyError, OSError, zlib.error):
            return None
    if not data.startswith(MAGIC) or b'\n' not in data:
        return None
    head, body = data.split(b'\n', 1)
    words = head.decode('utf8', 'replace').split(' ')
    try:
        n, of = (int(x) for x in words[-1].split('/'))
        d = dictionary(int(words[1][1:]))
        z = zlib.decompressobj(-15, zdict=d) if d else zlib.decompressobj(-15)
        text = abs_times((z.decompress(body) + z.flush()).decode('utf8', 'replace'))
    except (ValueError, IndexError, OSError, zlib.error):
        return None
    return ' '.join(words[2:-1]), n, of, text


def main(args):
    files = []
    for a in args:
        if os.path.isdir(a):
            files += sorted(os.path.join(a, f) for f in os.listdir(a) if not f.startswith('.'))
        else:
            files.append(a)
    if not files:
        sys.exit(__doc__)
    logs = {}                                  # (app version, pages, page 1's text) -> {page: text}
    for f in files:
        try:
            got = [p for p in (page(c) for c in codes(f)) if p]
        except Exception as e:                 # not an image, unreadable file
            print('# %s: %s' % (f, e), file=sys.stderr)
            continue
        if not got:
            print('# %s: no QR log code found' % f, file=sys.stderr)
        for app, n, of, text in got:
            # photos of the QR log at different times are different logs (their page 1s differ): kept apart.
            # A page other than 1 joins the log it was photographed with (the same app, version and page count).
            key = (app, of, text if n == 1 else None)
            if n != 1:
                key = next((k for k in logs if k[:2] == (app, of) and n not in logs[k]), key)
            logs.setdefault(key, {})[n] = text
    for (app, of, _), pages in logs.items():
        missing = [str(i) for i in range(1, of + 1) if i not in pages]
        print('# %s, %d of %d pages%s' % (app, len(pages), of, ', missing: ' + ', '.join(missing) if missing else ''))
        for i in sorted(pages, reverse=True):      # page 1 is the newest: printed last, so the log reads in time order
            print(pages[i])
    return 0 if logs else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
