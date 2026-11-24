'use strict';
/**
 * bg_art.js - designs/G20.png as the screen background: decoded once, carefully
 * downsampled, and dimmed so the photo keeps its natural texture on the display.
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
const MAX_SIDE = 2048;          // Store renderer's native pixmap limit (upstream supports 4096)
const VISIBLE = 0.98;           // image visibility (black veil sits at 0.02 over it)
const packIndexes = Object.create(null);
let loaded = false, geom = null, zonesGeom = null;
let baseImage = null, offImage = null, upperLightMask = null;
let footwellSpillMask = null, activeColorKey = '';

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
    // Area averaging applies a proper low-pass filter when reducing the 3072 px
    // design photo to the renderer's 2048 px texture limit. Center-sampled
    // bilinear interpolation skipped most source pixels and made cabin textures look
    // crunchy/over-sharp after scaling back up on the head unit.
    const weightsForAxis = (sourceSize, targetSize) => {
        const ratio = sourceSize / targetSize, weights = new Array(targetSize);
        for (let out = 0; out < targetSize; out++) {
            const start = out * ratio, end = (out + 1) * ratio, invSpan = 1 / (end - start);
            const taps = [];
            for (let input = Math.floor(start); input < Math.ceil(end); input++) {
                const overlap = Math.min(end, input + 1) - Math.max(start, input);
                if (overlap > 0) taps.push([input, overlap * invSpan]);
            }
            weights[out] = taps;
        }
        return weights;
    };
    const xWeights = weightsForAxis(source.width, width), yWeights = weightsForAxis(source.height, height);
    for (let y = 0; y < height; y++) {
        const yt = yWeights[y];
        for (let x = 0; x < width; x++) {
            const to = (y * width + x) * 4;
            let r = 0, g = 0, b = 0;
            const xt = xWeights[x];
            for (let yi = 0; yi < yt.length; yi++) {
                const sy = yt[yi][0], wy = yt[yi][1], row = sy * source.width * 4;
                for (let xi = 0; xi < xt.length; xi++) {
                    const sx = xt[xi][0], weight = xt[xi][1] * wy, from = row + sx * 4;
                    r += src[from] * weight;
                    g += src[from + 1] * weight;
                    b += src[from + 2] * weight;
                }
            }
            target[to] = Math.round(r);
            target[to + 1] = Math.round(g);
            target[to + 2] = Math.round(b);
            target[to + 3] = 255;
        }
    }
    return { width, height, rgba: target };
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

// Boundary between the upper trim and footwell glow in the cabin photo.
// The glovebox underside rises toward the passenger door, then follows its
// lower edge. A straight horizontal split cuts across that shape and leaves
// fragments of the upper colour in the footwell.
const LOWER_ZONE_EDGE = [
    [0.00, 0.94], [0.16, 0.88], [0.28, 0.76], [0.40, 0.62],
    [0.52, 0.55], [0.64, 0.53], [0.74, 0.56], [0.84, 0.62],
    [0.94, 0.70], [1.00, 0.75],
];
function lowerZoneBoundary(x) {
    for (let i = 1; i < LOWER_ZONE_EDGE.length; i++) {
        const right = LOWER_ZONE_EDGE[i];
        if (x > right[0]) continue;
        const left = LOWER_ZONE_EDGE[i - 1];
        const t = (x - left[0]) / (right[0] - left[0]);
        return left[1] + (right[1] - left[1]) * t;
    }
    return LOWER_ZONE_EDGE[LOWER_ZONE_EDGE.length - 1][1];
}

function buildFootwellSpillMask(width, height) {
    const mask = new Float32Array(width * height), leftByX = new Float32Array(width), edgeByX = new Float32Array(width);
    for (let x = 0; x < width; x++) {
        const xNorm = x / Math.max(1, width - 1);
        leftByX[x] = smoothstep(0.25, 0.38, xNorm) * (1 - smoothstep(0.48, 0.58, xNorm));
        edgeByX[x] = lowerZoneBoundary(xNorm);
    }
    for (let y = 0; y < height; y++) {
        const yNorm = y / Math.max(1, height - 1), row = y * width;
        for (let x = 0; x < width; x++) {
            const yFalloff = smoothstep(edgeByX[x] + 0.015, edgeByX[x] + 0.13, yNorm)
                * (1 - smoothstep(0.84, 0.95, yNorm));
            mask[row + x] = leftByX[x] * yFalloff;
        }
    }
    return mask;
}

// Only the two actual upper ambient strips should take the selected upper hue.
// Keeping the rest of the dashboard out of this mask prevents blue reflections
// on the dash surface from being recoloured as if they were light strips.
const UPPER_LIGHT_PATHS = [
    // Follow the real dashboard LED edge through its original pointed end.
    // The tight mask keeps the photo's natural tapered cap intact.
    { radius: 12, points: [[0.428, 0.505], [0.449, 0.489], [0.475, 0.470], [0.501, 0.452], [0.527, 0.435], [0.553, 0.417],
        [0.579, 0.400], [0.605, 0.383], [0.632, 0.372], [0.658, 0.363], [0.684, 0.355], [0.695, 0.350], [0.696, 0.349]] },
    // Door strip under the handle. Follow its downward bend precisely; the old
    // coarse curve stayed too high and caused the last section to be extinguished.
    { radius: 24, points: [[0.704, 0.451], [0.729, 0.462], [0.753, 0.484], [0.777, 0.517], [0.801, 0.551], [0.824, 0.580]] },
];
const FOOTWELL_SPILL_MAX = 0.24;

function buildUpperLightMask(width, height, light, maskBit, mask) {
    mask = mask || new Uint8Array(width * height);
    maskBit = maskBit || 1;
    const lights = light ? [light] : UPPER_LIGHT_PATHS;
    for (const item of lights) {
        const path = item.points, radius = item.radius;
        for (let j = 1; j < path.length; j++) {
            const ax = path[j - 1][0] * width, ay = path[j - 1][1] * height;
            const bx = path[j][0] * width, by = path[j][1] * height;
            const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
            const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - radius));
            const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + radius));
            const y0 = Math.max(0, Math.floor(Math.min(ay, by) - radius));
            const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + radius));
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const t = lenSq ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq)) : 0;
                const px = ax + t * dx, py = ay + t * dy;
                if ((x - px) * (x - px) + (y - py) * (y - py) <= radius * radius) mask[y * width + x] |= maskBit;
            }
        }
    }
    return mask;
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
function setColors(upperHex, lowerHex, enabled, doorHex) {
    if (!loaded || !baseImage) return;
    const key = enabled === false ? 'OFF' : (upperHex || '') + '|' + (doorHex || upperHex || '') + '|' + (lowerHex || '');
    if (key === activeColorKey) return;
    activeColorKey = key;
    if (enabled === false) {
        const off = makeOffImage();
        setImage(IMAGE_ID, off.width, off.height, off.rgba);
        return;
    }
    const upper = parseHexColor(upperHex), lower = parseHexColor(lowerHex);
    const door = parseHexColor(doorHex || upperHex);
    if (!upper && !lower) {
        setImage(IMAGE_ID, baseImage.width, baseImage.height, baseImage.rgba);
        return;
    }

    const { width, height, rgba } = baseImage;
    const tinted = new Uint8Array(rgba);
    const upperHsv = upper && rgbToHsv(upper[0], upper[1], upper[2]);
    const doorHsv = door && rgbToHsv(door[0], door[1], door[2]);
    const lowerHsv = lower && rgbToHsv(lower[0], lower[1], lower[2]);
    if ((upperHsv || doorHsv) && !upperLightMask) {
        upperLightMask = new Uint8Array(width * height);
        buildUpperLightMask(width, height, UPPER_LIGHT_PATHS[0], 1, upperLightMask);
        buildUpperLightMask(width, height, UPPER_LIGHT_PATHS[1], 2, upperLightMask);
    }
    const off = upperHsv || doorHsv ? makeOffImage().rgba : null;
    const edgeByX = new Float32Array(width);
    for (let x = 0; x < width; x++) edgeByX[x] = lowerZoneBoundary(x / Math.max(1, width - 1));
    for (let y = 0; y < height; y++) {
        const normalizedY = y / Math.max(1, height - 1);
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
            // Put the full boundary strip on the footwell side. Anti-aliased
            // colour blending here left a visible trace of the upper combo hue.
            const lowerWeight = normalizedY >= edgeByX[x] ? 1 : 0;
            const upperWeight = 1 - lowerWeight;
            const upperAmount = upperHsv ? upperWeight : 0;
            const lowerAmount = lowerHsv ? lowerWeight : 0;
            if (upperAmount < 0.01 && lowerAmount < 0.01) continue;
            const i = row + x * 4;
            const [h, s, v] = rgbToHsv(rgba[i], rgba[i + 1], rgba[i + 2]);
            let amount = 0;
            if (v >= 0.035 && h >= 185 && h <= 270 && s >= 0.13) {
                const hueMask = smoothstep(185, 205, h) * (1 - smoothstep(255, 270, h));
                amount = hueMask * smoothstep(0.13, 0.48, s) * smoothstep(0.035, 0.16, v);
            }
            if (amount >= 0.01) {
                const pixel = y * width + x;
                const lightMask = upperLightMask ? upperLightMask[pixel] : 0;
                const onDashboardStrip = !!(lightMask & 1);
                const onDoorStrip = !!(lightMask & 2);
                const upperStrip = onDashboardStrip || onDoorStrip;
                if ((upperHsv || doorHsv) && upperWeight && !upperStrip) {
                    // Remove source-blue reflections from the dashboard surface;
                    // the selected hue is reserved for the light strips themselves.
                    tinted[i] = off[i]; tinted[i + 1] = off[i + 1]; tinted[i + 2] = off[i + 2];
                } else {
                    const targetHsv = upperWeight ? (onDoorStrip ? doorHsv : upperHsv) : lowerHsv;
                    const target = targetHsv ? hsvToRgb(targetHsv[0], targetHsv[1], v) : null;
                    if (!target) continue;
                    const r = target[0], g = target[1], b = target[2];
                    tinted[i] = Math.round(rgba[i] + (r - rgba[i]) * amount);
                    tinted[i + 1] = Math.round(rgba[i + 1] + (g - rgba[i + 1]) * amount);
                    tinted[i + 2] = Math.round(rgba[i + 2] + (b - rgba[i + 2]) * amount);
                }
            }

            if (lowerHsv && lowerWeight && footwellSpillMask) {
                // Add a soft footwell-only light spill toward the darker left
                // side, keeping texture while avoiding a black patch in the preview.
                const spill = FOOTWELL_SPILL_MAX * footwellSpillMask[y * width + x] * (1 - v * 0.35);
                if (spill > 0.005) {
                    tinted[i] = Math.min(255, Math.round(tinted[i] + lower[0] * spill));
                    tinted[i + 1] = Math.min(255, Math.round(tinted[i + 1] + lower[1] * spill));
                    tinted[i + 2] = Math.min(255, Math.round(tinted[i + 2] + lower[2] * spill));
                }
            }
        }
    }
    setImage(IMAGE_ID, width, height, tinted);
}

/** Decode, area-downsample, and dim once, then hand the pixels to the renderer. */
function load() {
    if (loaded) return;
    loaded = true;
    let img = decodePng(readPackedFile('designs', FILE));
    img = downscale(img);
    for (let i = 0; i < img.rgba.length; i += 4) {
        img.rgba[i] = Math.round(img.rgba[i] * VISIBLE);
        img.rgba[i + 1] = Math.round(img.rgba[i + 1] * VISIBLE);
        img.rgba[i + 2] = Math.round(img.rgba[i + 2] * VISIBLE);
    }
    baseImage = img;
    footwellSpillMask = buildFootwellSpillMask(img.width, img.height);
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
