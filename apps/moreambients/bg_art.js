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
const OFF_IMAGE_ID = 0x4d44;
const UPPER_LIGHT_ID = 0x4d45;
const LOWER_LIGHT_ID = 0x4d46;
const FILE = 'G20.png';
const ZONES_FILE = 'Zones.png';
const MAX_SIDE = 1024;          // Match the cabin preview's ~900 px height; avoids processing invisible pixels
const VISIBLE = 0.98;           // image visibility (black veil sits at 0.02 over it)
const packIndexes = Object.create(null);
let loaded = false, geom = null, zonesGeom = null;
let baseImage = null, offImage = null, offImageReady = false;
let upperLightMask = null, upperLightStrength = null, lowerLightMask = null;
let activeColorKey = '', fullColorKey = '', buildingColorKey = '';
let colorJobSeq = 0, onUpdate = null;
let requestedUpperBrightness = 100, requestedLowerBrightness = 100;
let drawOffBase = false, ambientLayersReady = false;

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

// The cabin photo's decode/tint loops are chunked so the head unit keeps painting
// frames (and the diag timers keep firing) while several megapixels are worked on.
const yieldNow = () => new Promise((r) => setTimeout(r, 0));

/** Decode an 8-bit RGB/RGBA PNG; keepAlpha keeps the alpha channel instead of compositing onto black. */
async function decodePng(bytes, keepAlpha) {
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
        if (y % 96 === 96 - 1) await yieldNow();
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

async function downscale(source) {
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
        if (y % 64 === 64 - 1) await yieldNow();
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

// Shared by the selected-colour layer and its base-image cleanup. If they use
// different thresholds the old blue can be erased where no new colour is drawn.
function lowerTintAmount(h, s, v, weight) {
    if (weight < 0.02 || v < 0.008 || h < 180 || h > 278 || s < 0.12) return 0;
    const hueMask = smoothstep(180, 198, h) * (1 - smoothstep(260, 278, h));
    return hueMask * smoothstep(0.12, 0.42, s) * weight;
}
function upperTintAmount(h, s, v) {
    if (v < 0.01 || h < 160 || h > 300 || s < 0.04) return 0;
    return smoothstep(160, 190, h) * (1 - smoothstep(270, 300, h))
        * smoothstep(0.04, 0.16, s) * smoothstep(0.01, 0.05, v);
}

// Limit the background-light simulation to the visible footwell and door-pocket
// glow. Keep these masks tight: the rest of the lower image is upholstery, trim,
// and seat fabric and must retain the original photo at every brightness level.
async function buildLowerLightMask(width, height) {
    const mask = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        if (y % 128 === 127) await yieldNow();
        const yn = y / Math.max(1, height - 1), row = y * width;
        for (let x = 0; x < width; x++) {
            const xn = x / Math.max(1, width - 1);
            // These soft bounds follow the original floor glow and door pocket.
            // The source-blue test below keeps leather and trim out of the effect.
            const floor = smoothstep(0.32, 0.40, xn) * (1 - smoothstep(0.68, 0.74, xn))
                * smoothstep(0.57, 0.66, yn) * (1 - smoothstep(0.94, 0.99, yn));
            const doorPocket = smoothstep(0.69, 0.76, xn) * (1 - smoothstep(0.95, 0.99, xn))
                * smoothstep(0.57, 0.65, yn) * (1 - smoothstep(0.81, 0.87, yn));
            mask[row + x] = Math.max(floor, doorPocket);
        }
    }
    return mask;
}

// One measured mask is shared by both the old-colour cleanup and the new-colour
// layer. Separate wide cleanup and narrow tint paths left blue fringes and black
// gaps at the dashboard bend when their curves differed by only a few pixels.
const UPPER_LIGHT_PATHS = [
    // Follow the visible dashboard LED through its full bend, then along the
    // trim. The corridor includes its soft blue edge but stays off the dash face.
    { radius: 4, points: [[0.407, 0.563], [0.410, 0.556], [0.413, 0.548], [0.416, 0.538], [0.422, 0.526], [0.428, 0.516], [0.434, 0.505], [0.440, 0.495], [0.449, 0.489], [0.475, 0.470], [0.501, 0.452], [0.527, 0.435], [0.553, 0.417],
        [0.579, 0.400], [0.605, 0.383], [0.632, 0.372], [0.658, 0.363], [0.684, 0.355], [0.695, 0.350], [0.696, 0.349]] },
    // Door strip under the handle. Follow its downward bend precisely; the old
    // coarse curve stayed too high and caused the last section to be extinguished.
    // Follow the door strip below the handle without tinting the surrounding trim.
    { radius: 6, points: [[0.704, 0.451], [0.729, 0.462], [0.753, 0.484], [0.777, 0.517], [0.801, 0.551], [0.824, 0.580], [0.850, 0.605], [0.878, 0.631]] },
];
function buildUpperLightMask(width, height, light, maskBit, mask, strengthMask) {
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
            const segmentLength = Math.sqrt(lenSq);
            let alongBefore = 0;
            for (let k = 1; k < j; k++) {
                const px = (path[k][0] - path[k - 1][0]) * width;
                const py = (path[k][1] - path[k - 1][1]) * height;
                alongBefore += Math.sqrt(px * px + py * py);
            }
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const t = lenSq ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq)) : 0;
                const px = ax + t * dx, py = ay + t * dy;
                if ((x - px) * (x - px) + (y - py) * (y - py) <= radius * radius) {
                    const pixel = y * width + x;
                    mask[pixel] |= maskBit;
                    if (strengthMask) {
                        const fade = item.startFade ? 0.08 + 0.92 * smoothstep(0, item.startFade, alongBefore + t * segmentLength) : 1;
                        strengthMask[pixel] = Math.max(strengthMask[pixel], Math.round(255 * fade));
                    }
                }
            }
        }
    }
    return mask;
}

/** Prepare the same interior photo with blue light strips extinguished. */
async function makeOffImage() {
    if (offImage || !baseImage) return offImage;
    const { width, height, rgba } = baseImage;
    if (!upperLightMask) {
        upperLightMask = new Uint8Array(width * height);
        upperLightStrength = new Uint8Array(width * height);
        buildUpperLightMask(width, height, UPPER_LIGHT_PATHS[0], 1, upperLightMask, upperLightStrength);
        buildUpperLightMask(width, height, UPPER_LIGHT_PATHS[1], 2, upperLightMask, upperLightStrength);
    }
    if (!lowerLightMask) lowerLightMask = await buildLowerLightMask(width, height);
    const dark = new Uint8Array(rgba);
    for (let y = 0; y < height; y++) {
        if (y % 128 === 128 - 1) await yieldNow();
        const row = y * width * 4, pixelRow = y * width;
        for (let x = 0; x < width; x++) {
            const pixel = pixelRow + x;
            const upperStrip = !!(upperLightMask[pixel] & 3);
            const lowerGlow = upperStrip ? 0 : lowerLightMask[pixel];
            if (!upperStrip && lowerGlow < 0.005) continue;
            const i = row + x * 4;
            const [h, s, v] = rgbToHsv(rgba[i], rgba[i + 1], rgba[i + 2]);
            // Use the same source-colour test as the live tint; the soft spatial
            // mask then removes the old spill without touching unrelated pixels.
            const upperSource = upperStrip
                ? upperTintAmount(h, s, v) * (upperLightStrength ? upperLightStrength[pixel] / 255 : 1)
                : 0;
            const lowerAmount = upperStrip ? 0 : lowerTintAmount(h, s, v, lowerGlow);
            if (upperSource <= 0.01 && lowerAmount <= 0.01) continue;
            const level = rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722;
            if (upperStrip) {
                // Extinguish the narrow LED paths while leaving the nearby trim intact.
                const offLevel = level * 0.025;
                dark[i] = Math.round(rgba[i] + (offLevel - rgba[i]));
                dark[i + 1] = Math.round(rgba[i + 1] + (offLevel - rgba[i + 1]));
                dark[i + 2] = Math.round(rgba[i + 2] + (offLevel - rgba[i + 2]));
            } else {
                // The broad floor/door spill is baked into this photo. Blue has low
                // perceived luminance, so plain grayscale would nearly black out
                // the floor. Keep a restrained neutral trace of its value so the
                // upholstery texture remains visible with ambient colour off.
                const amount = Math.min(1, lowerGlow * 4);
                const neutral = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) * 0.42;
                dark[i] = Math.round(rgba[i] + (neutral - rgba[i]) * amount);
                dark[i + 1] = Math.round(rgba[i + 1] + (neutral - rgba[i + 1]) * amount);
                dark[i + 2] = Math.round(rgba[i + 2] + (neutral - rgba[i + 2]) * amount);
            }
        }
    }
    offImage = { width, height, rgba: dark };
    return offImage;
}

/** Recolour the photo once; brightness changes then blend cached light layers on the GPU. */
function setColors(upperHex, lowerHex, enabled, doorHex, upperBrightness, lowerBrightness) {
    if (!loaded || !baseImage) return;
    upperBrightness = clampBrightness(upperBrightness);
    lowerBrightness = clampBrightness(lowerBrightness);
    requestedUpperBrightness = upperBrightness;
    requestedLowerBrightness = lowerBrightness;
    const hueKey = enabled === false ? 'OFF' : (upperHex || '') + '|' + (doorHex || upperHex || '') + '|' + (lowerHex || '');
    const key = hueKey + '|' + upperBrightness + '|' + lowerBrightness;
    if (key === activeColorKey) return;
    activeColorKey = key;

    // Invalidate older asynchronous work before returning to a cached colour.
    // Otherwise a quick mode/colour change can snap back to a stale hue.
    if (buildingColorKey && hueKey !== buildingColorKey) {
        colorJobSeq++;
        buildingColorKey = '';
    }

    if (hueKey === 'OFF') {
        if (fullColorKey === 'OFF' && drawOffBase && !ambientLayersReady) return;
        const seq = ++colorJobSeq;
        buildingColorKey = '';
        showOffImage(seq).catch(() => {});
        return;
    }
    if (hueKey === fullColorKey && (ambientLayersReady || !drawOffBase)) {
        // The renderer blends cached light layers with GPU opacity; a brightness drag
        // changes only these two scalars and uploads no new pixels.
        if (onUpdate) onUpdate();
        return;
    }
    // While a tint is being built, brightness drags only update the requested values.
    // The completed colour pass will use the newest pair and won't restart the HSV work.
    if (hueKey === buildingColorKey) return;
    buildingColorKey = hueKey;
    const seq = ++colorJobSeq;
    buildColors(seq, hueKey, upperHex, lowerHex, doorHex).catch(() => {
        if (!staleColor(seq)) { buildingColorKey = ''; activeColorKey = ''; }
    });
}
function clampBrightness(value) {
    value = Number(value);
    return Number.isFinite(value) ? Math.max(10, Math.min(100, value)) : 100;
}
const staleColor = (seq) => seq !== colorJobSeq;

async function showOffImage(seq) {
    await yieldNow();
    if (staleColor(seq)) return;
    const off = await makeOffImage();
    if (staleColor(seq) || !off) return;
    fullColorKey = 'OFF';
    if (!offImageReady) { setImage(OFF_IMAGE_ID, off.width, off.height, off.rgba); offImageReady = true; }
    drawOffBase = true;
    ambientLayersReady = false;
    if (onUpdate) onUpdate();
}

async function buildColors(seq, hueKey, upperHex, lowerHex, doorHex) {
    await yieldNow();
    if (staleColor(seq)) return;
    const upper = parseHexColor(upperHex), lower = parseHexColor(lowerHex);
    const door = parseHexColor(doorHex || upperHex);
    const { width, height, rgba } = baseImage;
    if (!upper && !lower) {
        setImage(IMAGE_ID, width, height, rgba);
        fullColorKey = hueKey;
        buildingColorKey = '';
        drawOffBase = false;
        ambientLayersReady = false;
        if (onUpdate) onUpdate();
        return;
    }

    // Start from the untouched photo. Only pixels that get a selected colour
    // are cleared from this copy; unselected zones keep their original lighting.
    const displayBase = new Uint8Array(rgba);
    const tinted = new Uint8Array(rgba);
    const zones = new Uint8Array(width * height); // 1 = accent strip, 2 = background glow
    const zoneOpacity = new Uint8Array(width * height);
    const upperHsv = upper && rgbToHsv(upper[0], upper[1], upper[2]);
    const doorHsv = door && rgbToHsv(door[0], door[1], door[2]);
    const lowerHsv = lower && rgbToHsv(lower[0], lower[1], lower[2]);
    if (!upperLightMask) {
        upperLightMask = new Uint8Array(width * height);
        upperLightStrength = new Uint8Array(width * height);
        buildUpperLightMask(width, height, UPPER_LIGHT_PATHS[0], 1, upperLightMask, upperLightStrength);
        buildUpperLightMask(width, height, UPPER_LIGHT_PATHS[1], 2, upperLightMask, upperLightStrength);
    }
    if (!lowerLightMask) lowerLightMask = await buildLowerLightMask(width, height);
    for (let y = 0; y < height; y++) {
        if (y % 32 === 32 - 1) { if (staleColor(seq)) return; await yieldNow(); }
        const normalizedY = y / Math.max(1, height - 1);
        const row = y * width * 4, pixelRow = y * width;
        for (let x = 0; x < width; x++) {
            const pixel = pixelRow + x;
            const i = row + x * 4;
            const lightMask = upperLightMask ? upperLightMask[pixel] : 0;
            const upperStrip = !!(lightMask & 3);
            const onDoorStrip = !!(lightMask & 2);
            const inLowerGlow = !upperStrip && lowerLightMask[pixel] >= 0.02;
            const lowerWeight = inLowerGlow ? lowerLightMask[pixel] : 0;
            // Never use the upper colour as a fallback for the whole photo.
            // Only pixels on a selected LED path receive that colour.
            const upperWeight = upperStrip ? 1 : 0;
            const upperTargetHsv = onDoorStrip ? doorHsv : upperHsv;
            if ((!upperWeight || !upperTargetHsv) && (!lowerHsv || lowerWeight < 0.02)) continue;
            const [h, s, v] = rgbToHsv(rgba[i], rgba[i + 1], rgba[i + 2]);
            // Keep the underlying source blue out of the photo even where the
            // dashboard end is softly tapered. Tint it with the same endpoint
            // mask so there is no blue dot beside a blunt, fully coloured cap.
            const endpointFade = upperLightStrength ? upperLightStrength[pixel] / 255 : 1;
            const upperSource = upperTargetHsv && upperStrip ? upperTintAmount(h, s, v) : 0;
            const upperAmount = upperSource * endpointFade;
            const lowerAmount = lowerHsv ? lowerTintAmount(h, s, v, lowerWeight) : 0;
            const targetHsv = upperStrip ? upperTargetHsv : lowerHsv;
            const tintAmount = upperStrip ? upperAmount : lowerAmount;
            const upperNeedsCleanup = upperTargetHsv && upperStrip && upperSource > 0.01;
            const lowerNeedsCleanup = lowerHsv && lowerWeight >= 0.02 && lowerAmount >= 0.01;
            if (upperNeedsCleanup || lowerNeedsCleanup) {
                const level = (rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722) * 0.025;
                const cleanAmount = upperStrip ? 1 : Math.min(1, lowerWeight * 4);
                displayBase[i] = Math.round(rgba[i] + (level - rgba[i]) * cleanAmount);
                displayBase[i + 1] = Math.round(rgba[i + 1] + (level - rgba[i + 1]) * cleanAmount);
                displayBase[i + 2] = Math.round(rgba[i + 2] + (level - rgba[i + 2]) * cleanAmount);
            }
            if (targetHsv && tintAmount >= 0.01) {
                const target = hsvToRgb(targetHsv[0], targetHsv[1], v);
                // Store the selected hue and let alpha reproduce the source
                // glow at any brightness without dimming the cabin photograph.
                tinted[i] = Math.round(target[0]);
                tinted[i + 1] = Math.round(target[1]);
                tinted[i + 2] = Math.round(target[2]);
                zones[pixel] = upperStrip ? 1 : 2;
                zoneOpacity[pixel] = Math.max(zoneOpacity[pixel], Math.round(255 * tintAmount));
            }

        }
    }
    if (staleColor(seq)) return;
    const upperLayer = new Uint8Array(rgba.length), lowerLayer = new Uint8Array(rgba.length);
    for (let pixel = 0; pixel < zones.length; pixel++) {
        if (zones[pixel] !== 1 && zones[pixel] !== 2) continue;
        const i = pixel * 4, layer = zones[pixel] === 1 ? upperLayer : lowerLayer;
        layer[i] = tinted[i]; layer[i + 1] = tinted[i + 1]; layer[i + 2] = tinted[i + 2]; layer[i + 3] = zoneOpacity[pixel];
    }
    // The cleaned photo is the opaque base. The two transparent pixmaps contain
    // only selected light pixels, so brightness blends on the GPU without pixel loops.
    setImage(IMAGE_ID, width, height, displayBase);
    setImage(UPPER_LIGHT_ID, width, height, upperLayer);
    setImage(LOWER_LIGHT_ID, width, height, lowerLayer);
    fullColorKey = hueKey;
    buildingColorKey = '';
    drawOffBase = false;
    ambientLayersReady = true;
    if (onUpdate) onUpdate();
}

/** Decode and scale the cabin image once at the size used by the on-screen preview. */
async function load() {
    if (loaded) return;
    loaded = true;
    let img = await decodePng(readPackedFile('designs', FILE));
    img = await downscale(img);
    for (let i = 0; i < img.rgba.length; i += 4) {
        img.rgba[i] = Math.round(img.rgba[i] * VISIBLE);
        img.rgba[i + 1] = Math.round(img.rgba[i + 1] * VISIBLE);
        img.rgba[i + 2] = Math.round(img.rgba[i + 2] * VISIBLE);
    }
    baseImage = img;
    lowerLightMask = await buildLowerLightMask(img.width, img.height);
    activeColorKey = '';
    fullColorKey = '';
    buildingColorKey = '';
    offImageReady = false;
    drawOffBase = false;
    ambientLayersReady = false;
    setImage(IMAGE_ID, img.width, img.height, img.rgba);
    geom = { w: img.width, h: img.height };
    try {
        const zones = await decodePng(readPackedFile('designs', ZONES_FILE));
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
    const x = W - w + 16, y = y0 + (fullH - h) / 2;
    cv.image(drawOffBase && offImageReady ? OFF_IMAGE_ID : IMAGE_ID, x, y, w, h);
    if (ambientLayersReady) {
        cv.alpha(requestedLowerBrightness / 100);
        cv.image(LOWER_LIGHT_ID, x, y, w, h);
        cv.alpha(requestedUpperBrightness / 100);
        cv.image(UPPER_LIGHT_ID, x, y, w, h);
        cv.alpha(1);
    }
}

module.exports = { load, setColors, draw, zones, setOnUpdate: (fn) => { onUpdate = fn; } };
