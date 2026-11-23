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
    { key: 'M760Li_Blue', file: 'CARS/G11-12/BMW_M760Li_G11_G12_FACELIFT_BLUE_REAR.png', sideFile: 'CARS/G11-12/BMW_M760Li_G11_G12_FACELIFT_BLUE_SIDEVIEW.png', label: 'M760Li G11/G12 BLUE', chassis: 'G11/G12', sourceWidth: 1800, sourceHeight: 1200, sideWidth: 1800, sideHeight: 1200, nativeAlpha: true, tips: [[459, 872], [557, 872], [1243, 872], [1341, 872]] },
    { key: 'M760Li_Red', file: 'CARS/G11-12/BMW_M760Li_G11_G12_FACELIFT_RED_REAR.png', sideFile: 'CARS/G11-12/BMW_M760Li_G11_G12_FACELIFT_RED_SIDEVIEW.png', label: 'M760Li G11/G12 RED', chassis: 'G11/G12', sourceWidth: 1800, sourceHeight: 1200, sideWidth: 1800, sideHeight: 1200, nativeAlpha: true, tips: [[459, 872], [557, 872], [1243, 872], [1341, 872]] },
    { key: 'M760Li_Black', file: 'CARS/G11-12/BMW_M760Li_G11_G12_FACELIFT_BLACK_REAR.png', sideFile: 'CARS/G11-12/BMW_M760Li_G11_G12_FACELIFT_BLACK_SIDEVIEW.png', label: 'M760Li G11/G12 BLACK', chassis: 'G11/G12', sourceWidth: 1800, sourceHeight: 1200, sideWidth: 1800, sideHeight: 1200, nativeAlpha: true, tips: [[459, 872], [557, 872], [1243, 872], [1341, 872]] },
    { key: 'M550i_G30_Blue', file: 'CARS/G30/BMW_M550i_G30_PREFACELIFT_BLUE_REAR.png', sideFile: 'CARS/G30/BMW_M550i_G30_PREFACELIFT_BLUE_SIDEVIEW.png', label: 'M550i G30 BLUE', chassis: 'G30', sourceWidth: 1800, sourceHeight: 1200, sideWidth: 1800, sideHeight: 1200, nativeAlpha: true, tips: [[510, 920], [1290, 920]] },
    { key: 'M550i_G30_Red', file: 'CARS/G30/BMW_M550i_G30_PREFACELIFT_RED_REAR.png', sideFile: 'CARS/G30/BMW_M550i_G30_PREFACELIFT_RED_SIDEVIEW.png', label: 'M550i G30 RED', chassis: 'G30', sourceWidth: 1800, sourceHeight: 1200, sideWidth: 1800, sideHeight: 1200, nativeAlpha: true, tips: [[510, 920], [1290, 920]] },
    { key: 'M550i_G30_Black', file: 'CARS/G30/BMW_M550i_G30_PREFACELIFT_BLACK_REAR.png', sideFile: 'CARS/G30/BMW_M550i_G30_PREFACELIFT_BLACK_SIDEVIEW.png', label: 'M550i G30 BLACK', chassis: 'G30', sourceWidth: 1800, sourceHeight: 1200, sideWidth: 1800, sideHeight: 1200, nativeAlpha: true, tips: [[510, 920], [1290, 920]] },
];
const SOURCE_W = 1536, SOURCE_H = 1024;
const SIDE_SOURCE_W = 2172, SIDE_SOURCE_H = 724;
// 1023x682 keeps the source 3:2 aspect ratio exactly while staying within the
// renderer's maximum 1024 x 1024 image dimensions.
const MAX_IMAGE_SIDE = 1023;
const IMAGE_ID = 0x564b;
const SIDE_IMAGE_ID = 0x564c;
const packIndexes = Object.create(null);
// Keep only the current chassis mask. The decoded RGBA car images already live
// in the renderer; retaining four full-resolution alpha masks needlessly used
// several extra megabytes for the lifetime of the app.
let silhouetteCache = null;
let sideSilhouetteCache = null;

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

/** Read one file from an app data folder, either loose in dev or from its .pack at runtime. */
function readPackedFile(folder, rel) {
    const direct = path.join(__dirname, folder, rel);
    if (fs.existsSync(direct)) return fs.readFileSync(direct);

    const packed = path.join(__dirname, folder + '.pack');
    const fd = fs.openSync(packed, 'r');
    try {
        const header = readExact(fd, 12, 0);
        if (header.toString('latin1', 0, 8) !== 'MGUPACK1') throw new Error('Car artwork pack signature is invalid');
        let packIndex = packIndexes[folder];
        if (!packIndex) {
            const indexSize = header.readUInt32LE(8);
            packIndex = JSON.parse(zlib.inflateRawSync(readExact(fd, indexSize, 12)).toString('utf8'));
            packIndex.dataStart = 12 + indexSize;
            packIndexes[folder] = packIndex;
        }
        const entry = packIndex.files[rel];
        if (!entry) throw new Error('Missing artwork: ' + rel);
        const packedBytes = readExact(fd, entry[1], packIndex.dataStart + entry[0]);
        return zlib.inflateRawSync(packedBytes);
    } finally {
        fs.closeSync(fd);
    }
}

/** Asset file path is relative to assets/. */
function readAsset(rel) { return readPackedFile('assets', rel); }
/** Design file path is relative to designs/. */
function readDesignAsset(rel) { return readPackedFile('designs', rel); }
function readCarArtwork(file) {
    return file.indexOf('CARS/') === 0 ? readDesignAsset(file) : readAsset('car-models/' + file);
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
function decodePng(bytes, background, silhouette, expectedWidth, expectedHeight, options) {
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
    const alphaOnly = !!(options && options.alphaOnly);
    const captureAlpha = alphaOnly || !(options && options.omitAlpha);
    const base = alphaOnly ? null : parseColor(background);
    const rgba = alphaOnly ? null : new Uint8Array(width * height * 4);
    const alphaData = captureAlpha ? new Uint8Array(width * height) : null;
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
            if (alphaData) alphaData[pixel] = Math.round(alpha * 255);
            if (alphaOnly) continue;
            rgba[outPos++] = Math.round(row[si] * alpha + base[0] * (1 - alpha));
            rgba[outPos++] = Math.round(row[si + 1] * alpha + base[1] * (1 - alpha));
            rgba[outPos++] = Math.round(row[si + 2] * alpha + base[2] * (1 - alpha));
            rgba[outPos++] = 255;
        }
        const swap = previous; previous = row; row = swap;
    }
    return { width, height, rgba, alpha: alphaData };
}

/** Trim only transparent padding from the new car art; original PNG files stay untouched. */
function cropToAlpha(source) {
    if (!source.alpha) return source;
    let left = source.width, top = source.height, right = -1, bottom = -1;
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
        if (source.alpha[y * source.width + x] <= 8) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
    }
    if (right < left || bottom < top) return source;
    const pad = 3;
    left = Math.max(0, left - pad); top = Math.max(0, top - pad);
    right = Math.min(source.width - 1, right + pad); bottom = Math.min(source.height - 1, bottom + pad);
    const width = right - left + 1, height = bottom - top + 1;
    if (width === source.width && height === source.height) return source;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const from = ((top + y) * source.width + left) * 4;
        rgba.set(source.rgba.subarray(from, from + width * 4), y * width * 4);
    }
    return { width, height, rgba, crop: { x: left, y: top, width, height } };
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
    const sourceWidth = selected.sourceWidth || SOURCE_W;
    const sourceHeight = selected.sourceHeight || SOURCE_H;
    if (selected.nativeAlpha || selected.key.slice(-5) === '_Blue') {
        silhouetteCache = null;
    } else {
        if (!silhouetteCache || silhouetteCache.chassis !== selected.chassis) {
            const companion = MODELS.find((entry) => entry.chassis === selected.chassis && entry.key.slice(-5) === '_Blue');
            if (!companion) throw new Error('Missing transparent silhouette for ' + selected.chassis);
            const mask = decodePng(readCarArtwork(companion.file), background, null,
                companion.sourceWidth || SOURCE_W, companion.sourceHeight || SOURCE_H,
                { alphaOnly: true }).alpha;
            silhouetteCache = { chassis: selected.chassis, alpha: mask };
        }
        silhouette = silhouetteCache.alpha;
    }
    // Red/Black source files include a baked studio backdrop. Reuse the already
    // transparent same-body Blue cutout as a mask so the car pixels are preserved.
    const source = decodePng(readCarArtwork(selected.file), background, silhouette,
        sourceWidth, sourceHeight, { omitAlpha: !selected.nativeAlpha });
    const visual = selected.nativeAlpha ? cropToAlpha(source) : source;
    const crop = visual.crop || { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
    const resized = downscale(visual);
    setImage(IMAGE_ID, resized.width, resized.height, resized.rgba);
    return {
        id: IMAGE_ID, imageId: IMAGE_ID, width: resized.width, height: resized.height,
        model: selected,
        exhaustTips: selected.tips.map((p) => [(p[0] - crop.x) / crop.width, (p[1] - crop.y) / crop.height]),
    };
}

/** Load the paired side-view PNG for DYNO MODE without modifying its source artwork. */
function loadSide(value, background) {
    const selected = model(value);
    const sourceWidth = selected.sideWidth || SIDE_SOURCE_W;
    const sourceHeight = selected.sideHeight || SIDE_SOURCE_H;
    let silhouette = null;
    if (selected.nativeAlpha || selected.key.slice(-5) === '_Blue') {
        sideSilhouetteCache = null;
    } else {
        if (!sideSilhouetteCache || sideSilhouetteCache.chassis !== selected.chassis) {
            const companion = MODELS.find((entry) => entry.chassis === selected.chassis && entry.key.slice(-5) === '_Blue');
            if (!companion) throw new Error('Missing transparent side-view silhouette for ' + selected.chassis);
            const mask = decodePng(readCarArtwork(companion.sideFile), background, null,
                companion.sideWidth || SIDE_SOURCE_W, companion.sideHeight || SIDE_SOURCE_H,
                { alphaOnly: true }).alpha;
            sideSilhouetteCache = { chassis: selected.chassis, alpha: mask };
        }
        silhouette = sideSilhouetteCache.alpha;
    }
    const source = decodePng(readCarArtwork(selected.sideFile), background, silhouette,
        sourceWidth, sourceHeight, { omitAlpha: !selected.nativeAlpha });
    const resized = downscale(selected.nativeAlpha ? cropToAlpha(source) : source);
    setImage(SIDE_IMAGE_ID, resized.width, resized.height, resized.rgba);
    return {
        id: SIDE_IMAGE_ID, imageId: SIDE_IMAGE_ID, width: resized.width, height: resized.height,
        model: selected, sourceFile: selected.sideFile,
    };
}

module.exports = { MODELS, IMAGE_ID, SIDE_IMAGE_ID, SOURCE_W, SOURCE_H, SIDE_SOURCE_W, SIDE_SOURCE_H, model, load, loadSide, decodePng, downscale, readAsset, readDesignAsset };
