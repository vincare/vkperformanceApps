'use strict';
/**
 * bg_art.js - designs/G20.png as the screen background: decoded once, slightly
 * blurred and dimmed so it sits as a faint ghost image behind the black screen.
 * VISIBLE is how much of the photo shows through (0.05 = 5%).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
let setImage;
try { setImage = require('./kit/record').setImage; }
catch (e) { setImage = require('../../kit/runtime/record').setImage; }

const IMAGE_ID = 0x4d41;
const ZONES_ID = 0x4d43;
const FILE = 'G20.png';
const ZONES_FILE = 'Zones.png';
const MAX_SIDE = 1023;          // renderer's image limit
const VISIBLE = 0.98;           // image visibility (black veil sits at 0.02 over it)
const BLUR_R = 1;               // box-blur radius on the downscaled pixels (almost none)
const packIndexes = Object.create(null);
let loaded = false, geom = null, zonesGeom = null;
let baseImage = null, offImage = null, activeColorKey = '';

function readExact(fd, size, position) {
    const out = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
        const n = fs.readSync(fd, out, offset, size - offset, position + offset);
        if (!n) throw new Error('Unexpected end of designs pack');
        offset += n;
    }
    return out;
}

function readPackedFile(folder, rel) {
    const direct = path.join(__dirname, folder, rel);
    if (fs.existsSync(direct)) return fs.readFileSync(direct);
    const packed = path.join(__dirname, folder + '.pack');
    const fd = fs.openSync(packed, 'r');
    try {
        const header = readExact(fd, 12, 0);
        if (header.toString('latin1', 0, 8) !== 'MGUPACK1') throw new Error('Designs pack signature is invalid');
        let index = packIndexes[folder];
        if (!index) {
            const indexSize = header.readUInt32LE(8);
            index = JSON.parse(zlib.inflateRawSync(readExact(fd, indexSize, 12)).toString('utf8'));
            index.dataStart = 12 + indexSize;
            packIndexes[folder] = index;
        }
        const entry = index.files[rel];
        if (!entry) throw new Error('Missing design: ' + rel);
        return zlib.inflateRawSync(readExact(fd, entry[1], index.dataStart + entry[0]));
    } finally { fs.closeSync(fd); }
}

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode an 8-bit RGB/RGBA PNG; keepAlpha keeps the alpha channel instead of compositing onto black. */
function decodePng(bytes, keepAlpha) {
    if (bytes.length < 33 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('Not a PNG');
    let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
    const chunks = [];
    let pos = 8;
    while (pos + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(pos), type = bytes.toString('ascii', pos + 4, pos + 8);
        const start = pos + 8, end = start + length;
        if (end + 4 > bytes.length) throw new Error('Truncated PNG chunk: ' + type);
        if (type === 'IHDR') {
            width = bytes.readUInt32BE(start); height = bytes.readUInt32BE(start + 4);
            bitDepth = bytes[start + 8]; colorType = bytes[start + 9]; interlace = bytes[start + 12];
        } else if (type === 'IDAT') chunks.push(bytes.slice(start, end));
        pos = end + 4;
        if (type === 'IEND') break;
    }
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0)
        throw new Error('Unsupported PNG format');
    const channels = colorType === 6 ? 4 : 3, rowBytes = width * channels;
    const inflated = zlib.inflateSync(Buffer.concat(chunks));
    if (inflated.length !== (rowBytes + 1) * height) throw new Error('Invalid PNG pixel data length');
    const rgba = new Uint8Array(width * height * 4);
    let previous = Buffer.alloc(rowBytes), row = Buffer.alloc(rowBytes), inPos = 0, outPos = 0;
    for (let y = 0; y < height; y++) {
        const filter = inflated[inPos++];
        for (let x = 0; x < rowBytes; x++) {
            const raw = inflated[inPos++], left = x >= channels ? row[x - channels] : 0;
            const up = previous[x], upperLeft = x >= channels ? previous[x - channels] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = Math.floor((left + up) / 2);
            else if (filter === 4) predictor = paeth(left, up, upperLeft);
            else if (filter !== 0) throw new Error('Unsupported PNG filter ' + filter);
            row[x] = (raw + predictor) & 255;
        }
        for (let x = 0; x < width; x++) {
            const si = x * channels, a = channels === 4 ? row[si + 3] / 255 : 1;
            if (keepAlpha) {
                rgba[outPos++] = row[si]; rgba[outPos++] = row[si + 1]; rgba[outPos++] = row[si + 2];
                rgba[outPos++] = Math.round(a * 255);
            } else {
                rgba[outPos++] = Math.round(row[si] * a);
                rgba[outPos++] = Math.round(row[si + 1] * a);
                rgba[outPos++] = Math.round(row[si + 2] * a);
                rgba[outPos++] = 255;
            }
        }
        const swap = previous; previous = row; row = swap;
    }
    return { width, height, rgba };
}

function downscale(source) {
    const scale = Math.min(1, MAX_SIDE / source.width, MAX_SIDE / source.height);
    const width = Math.max(1, Math.floor(source.width * scale));
    const height = Math.max(1, Math.floor(source.height * scale));
    if (width === source.width && height === source.height) return source;
    const target = new Uint8Array(width * height * 4), src = source.rgba;
    for (let y = 0; y < height; y++) {
        const fy = (y + 0.5) * source.height / height - 0.5;
        const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(source.height - 1, y0 + 1), wy = Math.max(0, fy - y0);
        for (let x = 0; x < width; x++) {
            const fx = (x + 0.5) * source.width / width - 0.5;
            const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(source.width - 1, x0 + 1), wx = Math.max(0, fx - x0);
            const a = (y0 * source.width + x0) * 4, b = (y0 * source.width + x1) * 4;
            const c = (y1 * source.width + x0) * 4, d = (y1 * source.width + x1) * 4;
            const to = (y * width + x) * 4;
            for (let k = 0; k < 3; k++) {
                const top = src[a + k] + (src[b + k] - src[a + k]) * wx;
                const bottom = src[c + k] + (src[d + k] - src[c + k]) * wx;
                target[to + k] = Math.round(top + (bottom - top) * wy);
            }
            target[to + 3] = 255;
        }
    }
    return { width, height, rgba: target };
}

/** One separable box-blur pass (horizontal + vertical) at radius r. */
function boxBlur(source, r) {
    const { width, height, rgba } = source;
    const tmp = new Uint8Array(width * height * 4), out = new Uint8Array(width * height * 4);
    const n = r * 2 + 1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sr = 0, sg = 0, sb = 0;
            for (let k = -r; k <= r; k++) {
                const xx = Math.min(width - 1, Math.max(0, x + k)), i = (y * width + xx) * 4;
                sr += rgba[i]; sg += rgba[i + 1]; sb += rgba[i + 2];
            }
            const o = (y * width + x) * 4;
            tmp[o] = sr / n; tmp[o + 1] = sg / n; tmp[o + 2] = sb / n; tmp[o + 3] = 255;
        }
    }
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sr = 0, sg = 0, sb = 0;
            for (let k = -r; k <= r; k++) {
                const yy = Math.min(height - 1, Math.max(0, y + k)), i = (yy * width + x) * 4;
                sr += tmp[i]; sg += tmp[i + 1]; sb += tmp[i + 2];
            }
            const o = (y * width + x) * 4;
            out[o] = sr / n; out[o + 1] = sg / n; out[o + 2] = sb / n; out[o + 3] = 255;
        }
    }
    return { width, height, rgba: out };
}

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return [h, max ? d / max : 0, max];
}

function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function parseHexColor(hex) {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function smoothstep(a, b, value) {
    const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

/** Prepare the same interior photo with blue light strips extinguished. */
function makeOffImage() {
    if (offImage || !baseImage) return offImage;
    const { width, height, rgba } = baseImage;
    const dark = new Uint8Array(rgba);
    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
            const i = row + x * 4;
            const [h, s, v] = rgbToHsv(rgba[i], rgba[i + 1], rgba[i + 2]);
            if (v < 0.035 || h < 185 || h > 270 || s < 0.13) continue;
            const hueMask = smoothstep(185, 205, h) * (1 - smoothstep(255, 270, h));
            const amount = hueMask * smoothstep(0.13, 0.48, s) * smoothstep(0.035, 0.16, v);
            if (amount < 0.01) continue;
            // Turn the blue LED glow into a near-black neutral reflection, keeping the photo's texture.
            const level = (rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722) * 0.025;
            dark[i] = Math.round(rgba[i] + (level - rgba[i]) * amount);
            dark[i + 1] = Math.round(rgba[i + 1] + (level - rgba[i + 1]) * amount);
            dark[i + 2] = Math.round(rgba[i + 2] + (level - rgba[i + 2]) * amount);
        }
    }
    offImage = { width, height, rgba: dark };
    return offImage;
}

/** Recolour the photo when enabled, or show the same cabin with ambient lights off. */
function setColors(upperHex, lowerHex, enabled) {
    if (!loaded || !baseImage) return;
    const key = enabled === false ? 'OFF' : (upperHex || '') + '|' + (lowerHex || '');
    if (key === activeColorKey) return;
    activeColorKey = key;
    if (enabled === false) {
        const off = makeOffImage();
        setImage(IMAGE_ID, off.width, off.height, off.rgba);
        return;
    }
    const upper = parseHexColor(upperHex), lower = parseHexColor(lowerHex);
    if (!upper && !lower) {
        setImage(IMAGE_ID, baseImage.width, baseImage.height, baseImage.rgba);
        return;
    }

    const { width, height, rgba } = baseImage;
    const tinted = new Uint8Array(rgba);
    const upperHsv = upper && rgbToHsv(upper[0], upper[1], upper[2]);
    const lowerHsv = lower && rgbToHsv(lower[0], lower[1], lower[2]);
    const splitY = Math.round(height * 0.62); // dash and door strip above; footwell glow below
    for (let y = 0; y < height; y++) {
        const target = y < splitY ? upperHsv : lowerHsv;
        if (!target) continue;
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
            const i = row + x * 4;
            const [h, s, v] = rgbToHsv(rgba[i], rgba[i + 1], rgba[i + 2]);
            if (v < 0.035 || h < 185 || h > 270 || s < 0.13) continue;
            const hueMask = smoothstep(185, 205, h) * (1 - smoothstep(255, 270, h));
            const amount = hueMask * smoothstep(0.13, 0.48, s) * smoothstep(0.035, 0.16, v);
            if (amount < 0.01) continue;
            const [r, g, b] = hsvToRgb(target[0], target[1], v);
            tinted[i] = Math.round(rgba[i] + (r - rgba[i]) * amount);
            tinted[i + 1] = Math.round(rgba[i + 1] + (g - rgba[i + 1]) * amount);
            tinted[i + 2] = Math.round(rgba[i + 2] + (b - rgba[i + 2]) * amount);
        }
    }
    setImage(IMAGE_ID, width, height, tinted);
}

/** Decode + soften + dim once, then hand the pixels to the renderer. */
function load() {
    if (loaded) return;
    loaded = true;
    let img = decodePng(readPackedFile('designs', FILE));
    img = downscale(img);
    img = boxBlur(img, BLUR_R);
    for (let i = 0; i < img.rgba.length; i += 4) {
        img.rgba[i] = Math.round(img.rgba[i] * VISIBLE);
        img.rgba[i + 1] = Math.round(img.rgba[i + 1] * VISIBLE);
        img.rgba[i + 2] = Math.round(img.rgba[i + 2] * VISIBLE);
    }
    baseImage = img;
    activeColorKey = '';
    setImage(IMAGE_ID, img.width, img.height, img.rgba);
    geom = { w: img.width, h: img.height };
    try {
        const zones = decodePng(readPackedFile('designs', ZONES_FILE));
        setImage(ZONES_ID, zones.width, zones.height, zones.rgba);
        zonesGeom = { w: zones.width, h: zones.height };
    } catch (e) { zonesGeom = null; }
}

/** Zones.png (the cabin/zone icon) registered at load(); null until then. */
function zones() { return zonesGeom ? { id: ZONES_ID, w: zonesGeom.w, h: zonesGeom.h } : null; }

/** Uniform scale (no distortion), anchored right: just past full height so almost nothing is cropped. */
const HEIGHT_MULT = 1.25;       // bleeds past top & bottom so no black margin stays
const WIDTH_MULT = 1.13;        // keeps the same ~81% horizontal span from the right
/** Reach all the way to the screen's top & bottom (including cv.extra below 520 in full layout). */
function draw(cv, W, H) {
    if (!geom) return;
    const extra = cv.extra || 0;                // reading cv.extra tells display.js this page reaches the bottom
    const y0 = 0, fullH = H + extra + 24;       // +24 covers the small bottom gap
    const h = fullH * HEIGHT_MULT;
    const w = h * (geom.w / geom.h) * WIDTH_MULT;
    cv.image(IMAGE_ID, W - w + 16, y0 + (fullH - h) / 2, w, h);
}

module.exports = { load, setColors, draw, zones };
