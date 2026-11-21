'use strict';

/** Original BMW rear-view artwork and exhaust-tip anchors supplied with BMWaDESIGNS.zip. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
let setImage;
try { setImage = require('./kit/record').setImage; }
catch (e) { setImage = require('../../kit/runtime/record').setImage; }

const MODELS = [
    { key: 'M340i_Blue', file: 'M340i_Blue.png', sideFile: 'M340i_SideView_Blue.png', label: 'M340i G20 BLUE', chassis: 'G20', tips: [[276, 882], [377, 883], [1165, 883], [1265, 882]] },
    { key: 'M340i_Red', file: 'M340i_Red.png', sideFile: 'M340i_SideView_Red.png', label: 'M340i G20 RED', chassis: 'G20', tips: [[273, 882], [375, 882], [1167, 885], [1267, 882]] },
    { key: 'M340i_Black', file: 'M340i_Black.png', sideFile: 'M340i_SideView_Black.png', label: 'M340i G20 BLACK', chassis: 'G20', tips: [[271, 883], [374, 882], [1166, 882], [1267, 881]] },
    { key: 'M440i_Blue', file: 'M440i_Blue.png', sideFile: 'M440i_SideView_Blue.png', label: 'M440i G22 BLUE', chassis: 'G22', tips: [[285, 879], [384, 880], [1156, 881], [1254, 879]] },
    { key: 'M440i_Red', file: 'M440i_Red.png', sideFile: 'M440i_SideView_Red.png', label: 'M440i G22 RED', chassis: 'G22', tips: [[283, 880], [382, 881], [1158, 882], [1256, 880]] },
    { key: 'M440i_Black', file: 'M440i_Black.png', sideFile: 'M440i_SideView_Black.png', label: 'M440i G22 BLACK', chassis: 'G22', tips: [[279, 880], [381, 881], [1158, 881], [1260, 879]] },
];
const SOURCE_W = 1536, SOURCE_H = 1024;
const SIDE_SOURCE_W = 2172, SIDE_SOURCE_H = 724;
// 1023x682 keeps the source 3:2 aspect ratio exactly while staying within the
// renderer's maximum 1024 x 1024 image dimensions.
const MAX_IMAGE_SIDE = 1023;
const IMAGE_ID = 0x564b;
const SIDE_IMAGE_ID = 0x564c;
let packIndex = null;
const silhouetteByChassis = Object.create(null);
const sideSilhouetteByChassis = Object.create(null);

function model(value) {
    return MODELS.find((entry) => entry.key === value || entry.file === value) || MODELS[0];
}

function readExact(fd, size, position) {
    const out = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
        const n = fs.readSync(fd, out, offset, size - offset, position + offset);
        if (!n) throw new Error('Unexpected end of car artwork pack');
        offset += n;
    }
    return out;
}

function readPacked(file) {
    const folder = path.join(__dirname, 'assets', 'car-models');
    const direct = path.join(folder, file);
    if (fs.existsSync(direct)) return fs.readFileSync(direct);

    const packed = path.join(__dirname, 'assets.pack');
    const fd = fs.openSync(packed, 'r');
    try {
        const header = readExact(fd, 12, 0);
        if (header.toString('latin1', 0, 8) !== 'MGUPACK1') throw new Error('Car artwork pack signature is invalid');
        if (!packIndex) {
            const indexSize = header.readUInt32LE(8);
            packIndex = JSON.parse(zlib.inflateRawSync(readExact(fd, indexSize, 12)).toString('utf8'));
            packIndex.dataStart = 12 + indexSize;
        }
        const entry = packIndex.files['car-models/' + file];
        if (!entry) throw new Error('Missing car artwork: ' + file);
        const packedBytes = readExact(fd, entry[1], packIndex.dataStart + entry[0]);
        return zlib.inflateRawSync(packedBytes);
    } finally {
        fs.closeSync(fd);
    }
}

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function parseColor(hex) {
    const s = String(hex || '#050506').replace('#', '');
    return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
}

/** Decode the supplied 8-bit RGB/RGBA PNGs and composite transparency onto the page background. */
function decodePng(bytes, background, silhouette, expectedWidth, expectedHeight) {
    if (bytes.length < 33 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('Car artwork is not a PNG');
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
    const wantWidth = expectedWidth || SOURCE_W, wantHeight = expectedHeight || SOURCE_H;
    if (width !== wantWidth || height !== wantHeight) throw new Error('Unexpected car artwork size ' + width + 'x' + height);
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error('Unsupported car artwork PNG format');
    }
    const channels = colorType === 6 ? 4 : 3, rowBytes = width * channels;
    const inflated = zlib.inflateSync(Buffer.concat(chunks));
    if (inflated.length !== (rowBytes + 1) * height) throw new Error('Invalid PNG pixel data length');
    const base = parseColor(background);
    const rgba = new Uint8Array(width * height * 4);
    const alphaData = new Uint8Array(width * height);
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
            const si = x * channels, pixel = y * width + x;
            const sourceAlpha = channels === 4 ? row[si + 3] / 255 : 1;
            const alpha = silhouette ? silhouette[pixel] / 255 : sourceAlpha;
            alphaData[pixel] = Math.round(alpha * 255);
            rgba[outPos++] = Math.round(row[si] * alpha + base[0] * (1 - alpha));
            rgba[outPos++] = Math.round(row[si + 1] * alpha + base[1] * (1 - alpha));
            rgba[outPos++] = Math.round(row[si + 2] * alpha + base[2] * (1 - alpha));
            rgba[outPos++] = 255;
        }
        const swap = previous; previous = row; row = swap;
    }
    return { width, height, rgba, alpha: alphaData };
}

/** Bilinear downscale once to the renderer's 1024-pixel image limit. Source files remain unchanged. */
function downscale(source) {
    const scale = Math.min(1, MAX_IMAGE_SIDE / source.width, MAX_IMAGE_SIDE / source.height);
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

function load(value, background) {
    const selected = model(value);
    let silhouette = null;
    if (selected.key.slice(-5) !== '_Blue') {
        silhouette = silhouetteByChassis[selected.chassis];
        if (!silhouette) {
            const companion = MODELS.find((entry) => entry.chassis === selected.chassis && entry.key.slice(-5) === '_Blue');
            if (!companion) throw new Error('Missing transparent silhouette for ' + selected.chassis);
            silhouette = decodePng(readPacked(companion.file), background).alpha;
            silhouetteByChassis[selected.chassis] = silhouette;
        }
    }
    // Red/Black source files include a baked studio backdrop. Reuse the already
    // transparent same-body Blue cutout as a mask so the car pixels are preserved.
    const resized = downscale(decodePng(readPacked(selected.file), background, silhouette));
    setImage(IMAGE_ID, resized.width, resized.height, resized.rgba);
    return {
        id: IMAGE_ID, imageId: IMAGE_ID, width: resized.width, height: resized.height,
        model: selected, exhaustTips: selected.tips.map((p) => [p[0] / SOURCE_W, p[1] / SOURCE_H]),
    };
}

/** Load the paired side-view PNG for DYNO MODE without modifying its source artwork. */
function loadSide(value, background) {
    const selected = model(value);
    let silhouette = null;
    if (selected.key.slice(-5) !== '_Blue') {
        silhouette = sideSilhouetteByChassis[selected.chassis];
        if (!silhouette) {
            const companion = MODELS.find((entry) => entry.chassis === selected.chassis && entry.key.slice(-5) === '_Blue');
            if (!companion) throw new Error('Missing transparent side-view silhouette for ' + selected.chassis);
            silhouette = decodePng(readPacked(companion.sideFile), background, null, SIDE_SOURCE_W, SIDE_SOURCE_H).alpha;
            sideSilhouetteByChassis[selected.chassis] = silhouette;
        }
    }
    const resized = downscale(decodePng(readPacked(selected.sideFile), background, silhouette, SIDE_SOURCE_W, SIDE_SOURCE_H));
    setImage(SIDE_IMAGE_ID, resized.width, resized.height, resized.rgba);
    return {
        id: SIDE_IMAGE_ID, imageId: SIDE_IMAGE_ID, width: resized.width, height: resized.height,
        model: selected, sourceFile: selected.sideFile,
    };
}

module.exports = { MODELS, IMAGE_ID, SIDE_IMAGE_ID, SOURCE_W, SOURCE_H, SIDE_SOURCE_W, SIDE_SOURCE_H, model, load, loadSide, decodePng, downscale };
