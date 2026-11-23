'use strict';

const W = 1600, H = 520;
const RED = '#f32635';
let bladeProgress = null;
let bladeUpdatedAt = 0;

function drawSmoke(cv, G, t, car, imageRect, now, valveMode) {
    if (!car || !car.exhaustTips || car.exhaustTips.length < 2) return;
    const seconds = (now || Date.now()) / 1000;
    const open = valveMode === 'OPEN' || valveMode == null;
    const tips = car.exhaustTips;
    const grey = '#c8cdd4';
    tips.forEach((tip, tipIndex) => {
        // The valve sits on the image-right outlets. CLOSED: no plume there —
        // gas exits only through the free (left) side.
        if (!open && tipIndex >= tips.length / 2) return;
        const originX = imageRect.x + tip[0] * imageRect.w;
        const originY = imageRect.y + tip[1] * imageRect.h;
        const outward = tipIndex < tips.length / 2 ? -1 : 1;
        // Five staggered, soft wisps per active tip. Anchors stay tied to the
        // measured source-PNG exhaust positions through contain scaling.
        for (let puff = 0; puff < 10; puff++) {
            const phase = (seconds * 0.42 + puff / 10 + tipIndex * 0.063) % 1;
            const driftX = outward * (2 + phase * Math.min(44, imageRect.w * 0.088));
            const driftY = 2 + phase * Math.min(56, imageRect.h * 0.15);
            const sway = Math.sin(seconds * 2.4 + puff * 1.4 + tipIndex * 1.3) * (2.5 + phase * 4.5);
            const x = originX + driftX + sway;
            const y = originY + driftY;
            const radius = 4 + phase * Math.min(31, imageRect.h * 0.085);
            const fade = (1 - phase) * (0.55 + 0.45 * Math.min(1, phase * 5));
            cv.circle(x, y, radius, G.withAlpha(grey, 0.22 * fade));
            cv.circle(x, y, radius * 0.68, G.withAlpha('#d6dbe2', 0.36 * fade));
            cv.circle(x, y, radius * 0.36, G.withAlpha('#eceff3', 0.34 * fade));
        }
    });
}

function hash(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }

// Burble pops: irregular flame bursts per tip — hot white/yellow core flash,
// orange tongue streaking outward+down, plus a few sparks. Deterministic
// per-pop hash keeps each burst stable across frames.
function drawFlames(cv, G, t, car, imageRect, now) {
    if (!car || !car.exhaustTips || car.exhaustTips.length < 2) return;
    const seconds = (now || Date.now()) / 1000;
    const tips = car.exhaustTips;
    tips.forEach((tip, tipIndex) => {
        const ox = imageRect.x + tip[0] * imageRect.w;
        const oy = imageRect.y + tip[1] * imageRect.h;
        const outward = tipIndex < tips.length / 2 ? -1 : 1;
        const rate = 5.4;
        const slot = Math.floor(seconds * rate + tipIndex * 0.37);
        const phase = (seconds * rate + tipIndex * 0.37) % 1;
        const strength = hash(slot * 7.13 + tipIndex * 31.7);
        if (strength < 0.15 || phase > 0.72) return;
        const burst = strength * Math.sin((phase / 0.72) * Math.PI);
        const core = Math.max(0, 1 - phase * 1.9) * strength;
        if (core > 0.02) {
            cv.circle(ox, oy + 2, 10 + core * 11, G.withAlpha('#ff5a1f', 0.5 * core));
            cv.circle(ox, oy + 2, 6.5 + core * 7, G.withAlpha('#ffd23f', 0.8 * core));
            cv.circle(ox, oy + 2, 3.5 + core * 4, G.withAlpha('#fff6d8', 0.95 * core));
        }
        const len = 14 + burst * Math.min(80, imageRect.h * 0.2);
        for (let s = 0; s < 6; s++) {
            const u = s / 5;
            const fx = ox + outward * (2 + u * len * 0.55) +
                Math.sin(seconds * 31 + s * 2.1 + tipIndex) * (1 + u * 3.5);
            const fy = oy + 3 + u * len;
            const r = (1 - u) * (5.5 + burst * 9) * (0.9 + hash(slot + s * 3.7) * 0.4);
            if (r <= 0.6) continue;
            const col = u < 0.35 ? '#fff1c4' : u < 0.7 ? '#ffb31f' : '#ff4d12';
            cv.circle(fx, fy, r, G.withAlpha(col, (1 - u) * 0.85 * burst));
        }
        for (let s = 0; s < 3; s++) {
            const h2 = hash(slot * 13.7 + tipIndex * 7 + s * 3.1);
            const sp = (phase + h2 * 0.4) % 1;
            cv.circle(ox + outward * (4 + sp * 44) + (h2 - 0.5) * 16, oy + 2 + sp * (24 + h2 * 48),
                1.2 + (1 - sp) * 1.8, G.withAlpha('#ffd23f', (1 - sp) * 0.8 * strength));
        }
    });
}

function drawCar(cv, G, t, valve, car, bounds, now, effects) {
    if (!car || !car.imageId || !(car.width > 0) || !(car.height > 0)) {
        cv.text('CAR IMAGE UNAVAILABLE', bounds.x + bounds.w / 2, bounds.y + bounds.h / 2,
            20, t.dim, { align: 'center', font: 'bold', spacing: 1 });
        return;
    }
    // object-fit: contain equivalent: preserve the supplied PNG's full 3:2 frame.
    const imageRect = contain(bounds, car.width, car.height);
    cv.image(car.imageId, imageRect.x, imageRect.y, imageRect.w, imageRect.h);
    if (!effects) return;
    const valveMode = valve && valve.exhaustMode || 'OEM';
    if (effects === 'flames') {
        drawValveFlaps(cv, G, t, car, imageRect, valveMode, now);
        drawFlames(cv, G, t, car, imageRect, now);
    } else {
        drawSmoke(cv, G, t, car, imageRect, now, valveMode);
        drawValveFlaps(cv, G, t, car, imageRect, valveMode, now);
    }
}

// Full-card artwork per section (supplied badge images). A card shows its image
// at full size and is itself the button; without an image the vector icon card stays.
const SECTION_ART = {
    exhaust: 'ui/exhaust-system-badge.png', burbles: 'ui/exhaust-burbles-badge.png',
    dyno: 'ui/dyno-run-badge.png', drag: 'ui/drag-run-badge.png',
    valid: 'ui/drag-valid-stamp.png', invalid: 'ui/drag-invalid-stamp.png',
    engineInfo: 'ui/engine-info-badge.png', powertrain: 'ui/powertrain-badge.png',
    boost: 'ui/boost-badge.png', fuel: 'ui/fuel-system-badge.png',
    ignition: 'ui/ignition-badge.png', drivetrain: 'ui/drivetrain-badge.png',
    electrical: 'ui/electrical-badge.png', tyres: 'ui/tyres-badge.png',
    tyreWheel: 'ui/tyre-wheel.png',
};
let sectionArtSetImage;
const sectionArtCache = {};
function sectionArt(kind, bg) {
    const file = SECTION_ART[kind];
    if (!file) return null;
    const key = kind + '|' + bg;
    if (key in sectionArtCache) return sectionArtCache[key];
    let art = null;
    try {
        const CarImages = require('./car_images');
        if (!sectionArtSetImage) {
            try { sectionArtSetImage = require('./kit/record').setImage; }
            catch (e) { sectionArtSetImage = require('../../kit/runtime/record').setImage; }
        }
        const png = CarImages.readAsset(file);
        const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
        const d = CarImages.decodePng(png, bg, null, w, h, { omitAlpha: false });
        // Crop to the badge's own bounds so every card's art ends up the same on-screen size
        // (the source PNGs leave different margins around their badges).
        let x0 = w, y0 = h, x1 = 0, y1 = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            if (d.alpha[y * w + x] > 96) {
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
        const m = 6;
        x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
        x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
        const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
        const cropped = new Uint8Array(cw * ch * 4);
        for (let y = 0; y < ch; y++) cropped.set(d.rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4), y * cw * 4);
        const id = 0x5650 + Object.keys(SECTION_ART).indexOf(kind);
        sectionArtSetImage(id, cw, ch, cropped);
        art = { id, w: cw, h: ch };
    } catch (e) { art = null; }
    sectionArtCache[key] = art;
    return art;
}

function cachedSectionArt(kind, bg) {
    return sectionArtCache[kind + '|' + bg] || null;
}

function drawConfigCard(cv, G, t, x, y, w, h, title, subtitle, kind, action) {
    const art = sectionArt(kind, t.bg);
    if (art) {
        // Every badge at the same on-screen height: the badge itself is the button.
        const ih = 200, iw = Math.round(ih * art.w / art.h);
        const ix = x + (w - iw) / 2, iy = y + (h - ih) / 2;
        cv.image(art.id, ix, iy, iw, ih);
        if (cv.own && action) { cv.target(ix, iy, iw, ih, action, 'performance_' + kind + '_section', 30); return; }
    } else {
        cv.roundRect(x, y, w, h, 9, G.withAlpha('#ffffff', 0.035));
        cv.strokeRoundRect(x, y, w, h, 9, 1.5, G.withAlpha('#ffffff', 0.18));
        cv.fillRect(x + 1, y + 24, 4, 64, t.accent);
        const is = 220, ix = x + (w - is) / 2, iy = y + (h - is) / 2, cx = ix + is / 2, cy = iy + is / 2, k = is / 144;
        cv.roundRect(ix, iy, is, is, 10, G.withAlpha('#111317', 0.96));
        cv.strokeRoundRect(ix, iy, is, is, 10, 2, G.withAlpha(t.accent, 0.72));
        cv.fillRect(ix + 22 * k, iy + 14 * k, 44 * k, 3 * k, t.accent);
        if (kind === 'exhaust') {
            // A muffler body feeding dual M-style tips; the left tip shows the butterfly vane it controls.
            cv.roundRect(cx - 64 * k, cy - 6 * k, 26 * k, 12 * k, 4 * k, G.withAlpha('#7d858f', 0.92));
            cv.roundRect(cx - 40 * k, cy - 17 * k, 52 * k, 34 * k, 11 * k, G.withAlpha('#9ca4ae', 0.94));
            cv.roundRect(cx - 36 * k, cy - 13 * k, 44 * k, 26 * k, 8 * k, G.withAlpha('#191c21', 1));
            cv.line(cx - 30 * k, cy - 15.5 * k, cx + 4 * k, cy - 15.5 * k, 2 * k, G.withAlpha('#e2e7ec', 0.35));
            cv.roundRect(cx + 12 * k, cy - 5 * k, 26 * k, 10 * k, 4 * k, G.withAlpha('#7d858f', 0.92));
            [cx + 44 * k, cx + 62 * k].forEach((tx) => {
                cv.circle(tx, cy, 9.5 * k, G.withAlpha('#d4d9df', 0.98));
                cv.circle(tx, cy, 7 * k, G.withAlpha('#14161a', 1));
            });
            const fa = -0.7, fx = cx + 44 * k;
            cv.line(fx - Math.cos(fa) * 6 * k, cy - Math.sin(fa) * 6 * k, fx + Math.cos(fa) * 6 * k, cy + Math.sin(fa) * 6 * k,
                3.4 * k, G.withAlpha(t.accent, 0.95));
            cv.circle(fx, cy, 1.6 * k, G.withAlpha('#d4d9df', 0.9));
        } else {
            // One tip on the left popping staggered starbursts out to the right.
            cv.line(cx - 60 * k, cy, cx - 47 * k, cy, 13 * k, G.withAlpha('#7d858f', 0.92));
            cv.circle(cx - 38 * k, cy, 13.5 * k, G.withAlpha('#d4d9df', 0.98));
            cv.circle(cx - 38 * k, cy, 9.5 * k, G.withAlpha('#14161a', 1));
            cv.circle(cx - 38 * k, cy, 9.5 * k, G.withAlpha(t.accent, 0.14));
            const burst = (bx, by, r, c) => {
                for (let i = 0; i < 8; i++) {
                    const a = i * Math.PI / 4, r0 = r * 0.34, r1 = i % 2 ? r : r * 0.6;
                    cv.line(bx + Math.cos(a) * r0, by + Math.sin(a) * r0,
                        bx + Math.cos(a) * r1, by + Math.sin(a) * r1, 2.6 * k, c);
                }
                cv.circle(bx, by, r * 0.24, c);
            };
            burst(cx + 4 * k, cy - 16 * k, 15 * k, G.withAlpha('#ffb35c', 0.92));
            burst(cx + 32 * k, cy + 4 * k, 19 * k, G.withAlpha(t.accent, 0.95));
            burst(cx + 14 * k, cy + 24 * k, 11 * k, G.withAlpha('#ff8a3c', 0.9));
        }
    }
    if (cv.own && action) cv.target(x, y, w, h, action, 'performance_' + kind + '_section', 20);
}

function drawSectionMenu(cv, G, t, car, actions) {
    const y = (G.TOP || 44) + 30, h = 414, w = 760, gap = 32;
    drawConfigCard(cv, G, t, 24, y, w, h, 'EXHAUST SYSTEM', 'VALVE CONTROL · DRIVE MODES', 'exhaust', actions && actions.exhaust);
    drawConfigCard(cv, G, t, 24 + w + gap, y, w, h, 'EXHAUST BURBLES', 'BM3 BURBLE ADJUSTMENT', 'burbles', actions && actions.burbles);
}

function drawChip(cv, G, x, y, w, label, opts) {
    const bkH = 36;
    para(cv, x, y, w, y + bkH, 12, G.withAlpha('#ffffff', 0.08));
    if (opts && opts.icon === 'fwd') {
        cv.line(x + w - 24, y + 10, x + w - 16, y + bkH / 2, 2.4, '#ffffff');
        cv.line(x + w - 16, y + bkH / 2, x + w - 24, y + bkH - 10, 2.4, '#ffffff');
        cv.text(label, x + (w - 16) / 2, y + bkH / 2 + 6, 15, '#ffffff',
            { align: 'center', font: 'bold', spacing: 1.4, literal: true });
    } else if (opts && opts.icon === 'reset') {
        const cx0 = x + 20, cy0 = y + bkH / 2;
        cv.arc(cx0, cy0, 6.5, 8, 70, 390, '#ffffff', { round: true });
        const a = 30 * Math.PI / 180, tx = cx0 + Math.sin(a) * 7, ty = cy0 - Math.cos(a) * 7;
        cv.line(tx, ty, tx - 2.2, ty - 4.3, 2.4, '#ffffff');
        cv.line(tx, ty, tx - 4.8, ty + 0.3, 2.4, '#ffffff');
        cv.text(label, x + w / 2 + 7, y + bkH / 2 + 6, 15, '#ffffff',
            { align: 'center', font: 'bold', spacing: 1.4, literal: true });
    } else {
        cv.line(x + 22, y + 10, x + 14, y + bkH / 2, 2.4, '#ffffff');
        cv.line(x + 14, y + bkH / 2, x + 22, y + bkH - 10, 2.4, '#ffffff');
        cv.text(label, x + w / 2 + 7, y + bkH / 2 + 6, 15, '#ffffff',
            { align: 'center', font: 'bold', spacing: 1.4, literal: true });
    }
    if (cv.own && opts && opts.run) cv.target(x - 6, y - 4, w + 12, bkH + 8, opts.run, opts.key, 10);
}

function drawBackChip(cv, G, tagX, tagY, tagH, actions, targetKey, dy) {
    drawChip(cv, G, tagX, tagY + tagH + 14 + (dy || 0), 118, 'BACK',
        { icon: 'back', run: actions && actions.back, key: targetKey });
}

function drawBurbles(cv, G, t, valve, car, actions, now) {
    const y0 = (G.TOP || 44) + 8, y1 = H - 8, h = y1 - y0;
    const xAt = (xTop, y) => xTop - (y - y0) / h * SLANT;
    const tune = valve.tune || {};
    const enabled = tune.burblesEnabled === true;
    const current = enabled ? (typeof tune.burbles === 'number' ? tune.burbles.toFixed(1) : 'CUSTOM')
        : tune.burblesEnabled === false ? 'OFF' : 'UNKNOWN';
    const target = Number(valve.burbleTarget || 0).toFixed(1);
    const pending = String(target) !== String(current);

    // 1. Dark backdrop + subtle red hex lines across the whole background
    cv.fillRect(0, y0, W, h, t.bg);
    drawHexMesh(cv, G, y0, y1, false);

    // 2. Slanted black stage slab behind the car (same as EXHAUST SYSTEM)
    const slabX = 294, slabW = 740, slabS = Math.round(SLANT * (h - 12) / h);
    para(cv, slabX, y0 + 8, slabW, y1 - 4, slabS, '#000000');
    cv.line(slabX, y0 + 8, slabX + slabW, y0 + 8, 2, G.withAlpha('#f32635', 0.4));
    cv.line(slabX, y0 + 8, slabX - slabS, y1 - 4, 1.5, G.withAlpha('#f32635', 0.25));
    cv.line(slabX + slabW - slabS, y1 - 4, slabX + slabW, y0 + 8, 1.5, G.withAlpha('#f32635', 0.25));
    drawCar(cv, G, t, valve, car, { x: 267, y: y0 + 42, w: 650, h: h - 56 }, now, 'flames');

    // 3. Title tag + back chip
    const tagX = 40, tagY = y0 + 24, tagW = 300, tagH = 46, tagSlant = 15;
    para(cv, tagX, tagY, tagW, tagY + tagH, tagSlant, G.withAlpha('#c8192b', 0.94));
    cv.text('EXHAUST BURBLES', tagX + (tagW - tagSlant) / 2, tagY + 32, 24, '#ffffff',
        { align: 'center', font: 'num', spacing: 1.6, literal: true });
    drawBackChip(cv, G, tagX, tagY, tagH, actions, 'performance_burbles_4');

    // 4. Smooth diagonal panel on the right (same ribbon as EXHAUST SYSTEM)
    const ribX = 1128;
    para(cv, ribX,       y0, 210, y1, SLANT, '#2a0b12');
    para(cv, ribX + 210, y0, 112, y1, SLANT, '#1b070c');
    para(cv, ribX + 322, y0, 62,  y1, SLANT, '#8c1122');
    para(cv, ribX + 384, y0, 56,  y1, SLANT, '#d91c33');

    // 5. Control rows along the diagonal — same row/bar style as the mode rows
    const busy = !!valve.busy;
    const off = current === 'OFF';
    const rows = [
        ['DOWN',   'SOFTER',      false,   false, actions && actions.down,  'performance_burbles_0'],
        ['UP',     'LOUDER',      false,   false, actions && actions.up,    'performance_burbles_1'],
        ['APPLY',  'APPLY VALUE', pending, false, actions && actions.apply, 'performance_burbles_2'],
        ['CLOSED', 'BURBLES OFF', off,     off,   actions && actions.off,   'performance_burbles_3'],
    ];
    rows.forEach(([iconKey, label, redBar, rowActive, run, targetKey], i) => {
        const ry = y0 + 56 + i * 82;
        const rx = xAt(ribX + 26, ry);
        if (rowActive) {
            para(cv, rx - 18, ry - 22, 348, ry + 42, 22, G.withAlpha('#ffffff', 0.12));
            para(cv, rx - 18, ry - 22, 6,   ry + 42, 22, '#ff243b');
        }
        const ic = busy ? t.dim : rowActive ? '#ffffff' : G.withAlpha('#c8ced8', 0.78);
        modeIcon(cv, G, t, iconKey, rx + 12, ry + 6, 34, redBar ? '#ff243b' : ic);
        cv.text(label, rx + 44, ry + 8, 21, ic, { font: 'bold', spacing: 1.2, literal: true });
        drawBarSegs(cv, G, rx + 44, ry + 18, redBar);
        if (cv.own && run) cv.target(rx - 18, ry - 22, 348, 64, run, targetKey, 10);
    });

    // 6. Lower status block: full burble state, target and diagnostic status
    const setupY = y1 - 104, setupX = xAt(ribX + 12, setupY);
    cv.text('BURBLES · ' + current, setupX, setupY + 14, 20, '#ffffff',
        { font: 'bold', spacing: 1.1, literal: true });
    cv.text('TARGET · ' + target, setupX, setupY + 40, 13, '#ff8595',
        { font: 'bold', spacing: 0.8, literal: true });
    let status;
    if (!valve.ready) status = 'WAITING FOR DIAGNOSTIC LINK';
    else if (!valve.armed) status = 'CONTROL DISARMED';
    else if (!valve.bm3Rom) status = 'BM3 ROM NOT IDENTIFIED';
    else if (valve.commandStatus && /BURBLES/.test(valve.commandStatus)) status = valve.commandStatus;
    else status = 'BM3 ROM ' + valve.bm3Rom + ' · MANUAL APPLY';
    const warn = /DISARMED|UNAVAILABLE|REJECTED|BLOCKED|WAITING|NOT SENT|NOT IDENTIFIED|NOT CONFIRMED/.test(status);
    cv.text(status, setupX, setupY + 64, 10.5,
        warn ? '#ff5c70' : G.withAlpha('#e8c8ce', 0.55), { font: 'bold', spacing: 0.6, literal: true });
    if (!valve.bm3Rom && valve.bm3Error) {
        cv.text(String(valve.bm3Error).slice(0, 34).toUpperCase(), setupX, setupY + 84, 9,
            G.withAlpha('#e8c8ce', 0.4), { font: 'bold', spacing: 0.4, literal: true });
    }
}

// iDrive 8 (G8x M4) tile layout: dark navy backdrop with subtle hex mesh, the
// car in a slanted parallelogram frame on the left (like the map tile), and the
// full-height diagonal M-stripe ribbon on the right (purple -> navy -> cyan ->
// red) carrying the mode rows with red/white level bars underneath each label.
const SLANT = 152;
const CAR_TILE_BG = '#000000';

function para(cv, xTop, y0, w, y1, slant, c) {
    cv.quad([[xTop, y0], [xTop + w, y0], [xTop + w - slant, y1], [xTop - slant, y1]], c);
}

function vband(cv, G, xTop, y0, w, y1, slant, cTop, cMid, cBot) {
    const n = 10, dy = (y1 - y0) / n, ds = slant / n;
    for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n;
        const c = u < 0.5 ? G.mix(cTop, cMid, u * 2) : G.mix(cMid, cBot, (u - 0.5) * 2);
        const xt = xTop - ds * i, yt = y0 + dy * i;
        cv.quad([[xt, yt], [xt + w, yt], [xt + w - ds, yt + dy + 0.6], [xt - ds, yt + dy + 0.6]], c);
    }
}

function inCarBody(x, y, y0) {
    if (y < y0 + 72) return false;
    const u = Math.min(1, Math.max(0, (y - (y0 + 72)) / 360));
    const half = 175 + u * 105;
    return x > 592 - half && x < 592 + half;
}

function drawHexMesh(cv, G, y0, y1, skipCarBox) {
    const r = 104, dx = r * 1.5, dy = r * Math.sqrt(3);
    const c = G.withAlpha('#f32635', 0.13);
    if (cv.clip) cv.clip(0, y0, W, y1 - y0);
    for (let col = -1; col < 13; col++) {
        const cx = col * dx;
        for (let row = -1; row < 5; row++) {
            const cy = y0 + row * dy + (col & 1 ? dy / 2 : 0);
            const pts = [];
            for (let k = 0; k <= 6; k++) {
                const a = (k % 6) * Math.PI / 3;
                pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
            }
            for (let k = 0; k < 6; k++) {
                const p0 = pts[k], p1 = pts[k + 1];
                if (skipCarBox && (inCarBody(p0[0], p0[1], y0) || inCarBody(p1[0], p1[1], y0) ||
                    inCarBody((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, y0))) continue;
                if ((p0[1] >= y0 - 20 && p0[1] <= y1 + 20) || (p1[1] >= y0 - 20 && p1[1] <= y1 + 20))
                    cv.line(p0[0], p0[1], p1[0], p1[1], 1.25, c);
            }
        }
    }
    if (cv.noclip) cv.noclip();
}

function exhaustBell(cv, cx, cy, c) {
    // M-style exhaust muffler + flared tip silhouette facing right
    cv.fillRect(cx - 14, cy - 3.5, 5, 7, c);
    cv.quad([[cx - 9, cy - 3.5], [cx - 2, cy - 7.5], [cx - 2, cy + 7.5], [cx - 9, cy + 3.5]], c);
    cv.fillRect(cx - 2, cy - 7.5, 2.2, 15, c);
}

function modeIcon(cv, G, t, kind, cx, cy, s, c) {
    if (kind === 'OPEN') {
        exhaustBell(cv, cx, cy, c);
        cv.arc(cx - 2, cy, 5.5, 7.6, 52, 128, c, { round: true });
        cv.arc(cx - 2, cy, 10.0, 12.1, 48, 132, c, { round: true });
        cv.arc(cx - 2, cy, 14.5, 16.6, 44, 136, c, { round: true });
    } else if (kind === 'CLOSED') {
        exhaustBell(cv, cx, cy, c);
        cv.line(cx + 4, cy - 5.5, cx + 13, cy + 5.5, 2.5, c);
        cv.line(cx + 4, cy + 5.5, cx + 13, cy - 5.5, 2.5, c);
    } else if (kind === 'OEM') {
        cv.arc(cx, cy, 5.2, 9.6, 0, 360, c);
        for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            cv.line(cx + Math.cos(a) * 8.5, cy + Math.sin(a) * 8.5,
                cx + Math.cos(a) * 13.2, cy + Math.sin(a) * 13.2, 3.2, c);
        }
        cv.circle(cx, cy, 2.4, c);
    } else if (kind === 'DOWN') {
        exhaustBell(cv, cx, cy, c);
        cv.line(cx + 4, cy, cx + 15, cy, 2.6, c);
    } else if (kind === 'UP') {
        exhaustBell(cv, cx, cy, c);
        cv.line(cx + 4, cy, cx + 15, cy, 2.6, c);
        cv.line(cx + 9.5, cy - 5.5, cx + 9.5, cy + 5.5, 2.6, c);
    } else if (kind === 'APPLY') {
        cv.line(cx - 11, cy + 1, cx - 3, cy + 8, 3.2, c);
        cv.line(cx - 3, cy + 8, cx + 12, cy - 8, 3.2, c);
    } else if (kind === 'WHEELS') {
        cv.arc(cx, cy, 8.8, 13.2, 0, 360, c);
        cv.circle(cx, cy, 2.6, c);
        for (let i = 0; i < 5; i++) {
            const a = i * Math.PI * 2 / 5 - Math.PI / 2;
            cv.line(cx + Math.cos(a) * 4, cy + Math.sin(a) * 4,
                cx + Math.cos(a) * 10, cy + Math.sin(a) * 10, 2.2, c);
        }
    } else if (kind === 'SPEED') {
        // fast-forward chevrons: motion / vehicle speed
        cv.line(cx - 13, cy - 8, cx - 5, cy, 3.2, c);
        cv.line(cx - 5, cy, cx - 13, cy + 8, 3.2, c);
        cv.line(cx - 2, cy - 8, cx + 6, cy, 3.2, c);
        cv.line(cx + 6, cy, cx - 2, cy + 8, 3.2, c);
        cv.line(cx + 10, cy - 4, cx + 14, cy, 2.2, c);
        cv.line(cx + 14, cy, cx + 10, cy + 4, 2.2, c);
    } else if (kind === 'GFORCE') {
        cv.arc(cx, cy, 9.6, 12.6, 0, 360, c);
        cv.text('G', cx, cy + 7, 17, c, { align: 'center', font: 'bold' });
    } else if (kind === 'FLAG') {
        // finish flag: pole + checkered pennant
        cv.line(cx - 10, cy - 13, cx - 10, cy + 12, 2.6, c);
        cv.quad([[cx - 8, cy - 13], [cx + 13, cy - 9], [cx + 13, cy], [cx - 8, cy - 4]], c);
        cv.line(cx - 1, cy - 12, cx - 1, cy - 4, 2.6, t.bg);
        cv.line(cx + 6, cy - 10.5, cx + 6, cy - 2.5, 2.6, t.bg);
    } else if (kind === 'SLOPE') {
        // road grade: ground line + rising ramp + rise mark
        cv.line(cx - 14, cy + 8, cx + 14, cy + 8, 2.4, c);
        cv.line(cx - 14, cy + 8, cx + 8, cy - 7, 3, c);
        cv.line(cx + 8, cy - 7, cx + 8, cy + 8, 2, c);
    } else if (kind === 'RULER') {
        // ruler bar with tick marks (Dragy distance icon)
        cv.line(cx - 14, cy + 6, cx + 14, cy + 6, 2.6, c);
        cv.line(cx - 14, cy - 3, cx - 14, cy + 6, 2.4, c);
        cv.line(cx - 7,  cy,     cx - 7,  cy + 6, 2.0, c);
        cv.line(cx,      cy - 3, cx,      cy + 6, 2.4, c);
        cv.line(cx + 7,  cy,     cx + 7,  cy + 6, 2.0, c);
        cv.line(cx + 14, cy - 3, cx + 14, cy + 6, 2.4, c);
    } else {
        // Sport gauge / tachometer with scale ticks and needle
        cv.arc(cx, cy + 2, 11.2, 13.6, 225, 495, c, { round: true });
        [240, 300, 360, 420, 480].forEach((deg) => {
            const a = deg * Math.PI / 180;
            cv.line(cx + Math.sin(a) * 8.4, cy + 2 - Math.cos(a) * 8.4,
                cx + Math.sin(a) * 11.4, cy + 2 - Math.cos(a) * 11.4, 1.8, c);
        });
        const na = 425 * Math.PI / 180;
        cv.line(cx, cy + 2, cx + Math.sin(na) * 9.2, cy + 2 - Math.cos(na) * 9.2, 2.4, c);
        cv.circle(cx, cy + 2, 2.6, c);
    }
}

function drawBarSegs(cv, G, x, y, selected) {
    const sw = 68, sh = 4.5, gap = 7, sl = 4;
    const c0 = selected ? '#9ca4b0' : G.withAlpha('#8c94a0', 0.55);
    const c1 = selected ? '#ff243b' : G.withAlpha('#8c94a0', 0.42);
    cv.quad([[x + sl, y], [x + sl + sw, y], [x + sw, y + sh], [x, y + sh]], c0);
    const x2 = x + sw + gap;
    cv.quad([[x2 + sl, y], [x2 + sl + sw, y], [x2 + sw, y + sh], [x2, y + sh]], c1);
}

function drawExhaustSheet(cv, G, t, valve, car, actions, now) {
    const y0 = (G.TOP || 44) + 8, y1 = H - 8, h = y1 - y0;
    const xAt = (xTop, y) => xTop - (y - y0) / h * SLANT;

    // 1. Dark backdrop + subtle red hex lines across the whole background
    cv.fillRect(0, y0, W, h, t.bg);
    drawHexMesh(cv, G, y0, y1, false);

    // 2. Slanted black stage slab behind the car — same diagonal language as the right panel
    const slabX = 294, slabW = 740, slabS = Math.round(SLANT * (h - 12) / h);
    para(cv, slabX, y0 + 8, slabW, y1 - 4, slabS, '#000000');
    cv.line(slabX, y0 + 8, slabX + slabW, y0 + 8, 2, G.withAlpha('#f32635', 0.4));
    cv.line(slabX, y0 + 8, slabX - slabS, y1 - 4, 1.5, G.withAlpha('#f32635', 0.25));
    cv.line(slabX + slabW - slabS, y1 - 4, slabX + slabW, y0 + 8, 1.5, G.withAlpha('#f32635', 0.25));

    // 3. Car centered on the slab
    drawCar(cv, G, t, valve, car, { x: 267, y: y0 + 42, w: 650, h: h - 56 }, now, true);

    const tagX = 40, tagY = y0 + 24, tagW = 264, tagH = 46, tagSlant = 15;
    para(cv, tagX, tagY, tagW, tagY + tagH, tagSlant, G.withAlpha('#c8192b', 0.94));
    cv.text('EXHAUST SYSTEM', tagX + (tagW - tagSlant) / 2, tagY + 32, 24, '#ffffff',
        { align: 'center', font: 'num', spacing: 1.6, literal: true });
    drawBackChip(cv, G, tagX, tagY, tagH, actions, 'performance_flap_back');

    // 3. Smooth diagonal panel on the right (no banding segments or decorative outlines)
    const ribX = 1128;
    para(cv, ribX,       y0, 210, y1, SLANT, '#2a0b12');
    para(cv, ribX + 210, y0, 112, y1, SLANT, '#1b070c');
    para(cv, ribX + 322, y0, 62,  y1, SLANT, '#8c1122');
    para(cv, ribX + 384, y0, 56,  y1, SLANT, '#d91c33');

    // 4. Mode rows aligned along the diagonal of the ribbon:
    // Row 1 toggles CLOSED VALVES (1st grey bar) <-> OPENED VALVES (2nd red bar).
    const selKey = valve && valve.selected || 'OEM';
    const isOpen = selKey === 'OPEN';
    const isClosed = selKey === 'CLOSED';
    const toggleValves = () => {
        if (isOpen) return actions && actions.close && actions.close();
        return actions && actions.open && actions.open();
    };
    const rows = [
        [isOpen ? 'OPEN' : 'CLOSED', isOpen ? 'OPENED VALVES' : 'CLOSED VALVES', isOpen, isOpen || isClosed, toggleValves, 'performance_flap_OPEN'],
        ['OEM',   'OEM CONTROL',   selKey === 'OEM',   selKey === 'OEM',   actions.oem,   'performance_flap_OEM'],
        ['DRIVE', 'BY DRIVE MODE', selKey === 'DRIVE', selKey === 'DRIVE', actions.drive, 'performance_flap_DRIVE'],
    ];
    const FULL_MODE_NAMES = {
        OPEN: 'OPENED VALVES',
        CLOSED: 'CLOSED VALVES',
        OEM: 'OEM CONTROL',
        DRIVE: 'BY DRIVE MODE',
    };
    rows.forEach(([iconKey, label, redSecondBar, rowActive, run, targetKey], i) => {
        const ry = y0 + 64 + i * 86;
        const rx = xAt(ribX + 26, ry);
        const busy = valve.busy && iconKey !== 'OEM';
        if (rowActive) {
            para(cv, rx - 18, ry - 22, 348, ry + 42, 22, G.withAlpha('#ffffff', 0.12));
            para(cv, rx - 18, ry - 22, 6,   ry + 42, 22, isClosed && i === 0 ? '#9ca4b0' : '#ff243b');
        }
        const ic = busy ? t.dim : rowActive ? '#ffffff' : G.withAlpha('#c8ced8', 0.78);
        modeIcon(cv, G, t, iconKey, rx + 12, ry + 6, 34, redSecondBar ? '#ff243b' : ic);
        cv.text(label, rx + 44, ry + 8, 21, ic, { font: 'bold', spacing: 1.2, literal: true });
        drawBarSegs(cv, G, rx + 44, ry + 18, redSecondBar);
        if (cv.own && run) cv.target(rx - 18, ry - 22, 348, 64, run, targetKey, 10);
    });

    // 5. Lower-left status block showing the full name of the active mode
    const setupY = y1 - 108, setupX = xAt(ribX + 12, setupY);
    const fullMode = FULL_MODE_NAMES[selKey] || FULL_MODE_NAMES[valve.modeLabel] || 'OEM CONTROL';
    const modeTitle = 'MODE · ' + fullMode;
    cv.text(modeTitle, setupX, setupY + 14, 20, '#ffffff', { font: 'bold', spacing: 1.1, literal: true });
    const status = valve.commandStatus || 'READY FOR COMMAND';
    const warn = /DISARMED|UNAVAILABLE|REJECTED|BLOCKED|WAITING|NOT SENT|NOT CONFIRMED/.test(status);
    cv.text(status, setupX, setupY + 42, 13,
        warn ? '#ff5c70' : '#ff8595', { font: 'bold', spacing: 0.8, literal: true });
    cv.text('VALVE POSITION NOT SENSED', setupX, setupY + 66, 10, G.withAlpha('#e8c8ce', 0.55),
        { font: 'bold', spacing: 0.6, literal: true });
}

function drawValveFlaps(cv, G, t, car, imageRect, valveMode, now) {
    if (!car || !car.exhaustTips || car.exhaustTips.length < 2) return;
    const target = valveMode === 'OPEN' ? 1 : valveMode === 'CLOSED' ? 0 : 0.5;
    const time = now || Date.now();
    if (bladeProgress === null) bladeProgress = target;
    else {
        const dt = Math.max(0, Math.min(250, time - bladeUpdatedAt));
        bladeProgress += (target - bladeProgress) * (1 - Math.exp(-dt / 260));
    }
    bladeUpdatedAt = time;
    const angle = bladeProgress * Math.PI / 2;
    const radius = Math.max(3.5, Math.min(imageRect.w * 0.016, imageRect.h * 0.026));
    const bladeColor = valveMode === 'OPEN' ? '#d9dde2' : valveMode === 'CLOSED' ? RED : '#d8a84e';
    car.exhaustTips.forEach((tip) => {
        const cx = imageRect.x + tip[0] * imageRect.w;
        const cy = imageRect.y + tip[1] * imageRect.h;
        cv.circle(cx, cy, radius, G.withAlpha('#bcc3cc', 0.78));
        cv.circle(cx, cy, radius * 0.76, G.withAlpha('#111317', 0.96));
        const dx = Math.cos(angle) * radius * 0.68;
        const dy = Math.sin(angle) * radius * 0.68;
        cv.line(cx - dx, cy - dy, cx + dx, cy + dy,
            Math.max(1.6, radius * (0.23 - bladeProgress * 0.1)), G.withAlpha(bladeColor, 0.96));
        cv.circle(cx, cy, Math.max(1.3, radius * 0.16), G.withAlpha(RED, 0.9));
    });
}

function contain(rect, width, height) {
    const scale = Math.min(rect.w / width, rect.h / height);
    const w = width * scale, h = height * scale;
    return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

function drawActionButton(cv, G, t, x, y, w, h, label, run, opts) {
    // Draw square controls identically in the offline preview and on the head unit.
    const color = opts && opts.color || t.accent;
    const primary = !!(opts && opts.primary);
    const busy = !!(opts && opts.busy), radius = 5;
    cv.roundRect(x, y, w, h, radius, primary
        ? G.withAlpha(color, busy ? 0.32 : 0.88) : G.withAlpha('#ffffff', busy ? 0.035 : 0.07));
    cv.strokeRoundRect(x, y, w, h, radius, 1.5,
        G.withAlpha(color, busy ? 0.24 : primary ? 0.78 : 0.42));
    cv.text(String(label).toUpperCase(), x + w / 2, y + h / 2 + h * 0.15, h * 0.4,
        busy && !primary ? t.dim : '#ffffff', { align: 'center', font: 'bold', spacing: 1.5 });
    if (cv.own && run) cv.target(x, y, w, h, run, opts && opts.key || label);
}

function draw(cv, G, t, v, act, car, now, view, sectionActions) {
    cv.clear(t.bg);
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'RACE MODES', 'CAR DATA', 'WARMUP'], 1, [
        v.demo && { text: 'DEMO · NOT VEHICLE DATA', color: 'crit' },
    ]);
    G.sectionRule(cv, t, 24, G.TOP || 44, W - 48, t.stripes || RED);
    if (view === 'sections') drawSectionMenu(cv, G, t, car, sectionActions);
    else if (view === 'burbles') drawBurbles(cv, G, t, v, car, act, now);
    else drawExhaustSheet(cv, G, t, v, car, act, now);
    return cv;
}

module.exports = { W, H, CAR_TILE_BG, SLANT, draw, drawCar, drawSectionMenu, drawBurbles, drawExhaustSheet, drawSmoke, drawFlames, drawValveFlaps, contain, sectionArt, cachedSectionArt, para, drawHexMesh, drawBarSegs, modeIcon, drawChip, drawBackChip };
