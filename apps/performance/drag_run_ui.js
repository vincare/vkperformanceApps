'use strict';

const DragRun = require('./drag_run');
const Sheet = require('./flap_ui');

const W = 1600, H = 520;
const RED = '#f32635';
const SLANT = Sheet.SLANT;

function number(value, digits) {
    if (typeof value !== 'number' || !isFinite(value)) return '--';
    const scale = Math.pow(10, digits || 0);
    return String(Math.round(value * scale) / scale);
}

function contain(rect, width, height) {
    if (!(width > 0) || !(height > 0)) return rect;
    const scale = Math.min(rect.w / width, rect.h / height);
    const w = width * scale, h = height * scale;
    return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

function DragRunSpeed(kmh, unit) { return DragRun.speedValue(kmh, unit); }
function DragRunSeconds(value) { return DragRun.seconds(value); }

function hasTimedResults(run) {
    const result = run && run.result;
    return !!result && Object.keys(result).some((key) => typeof result[key] === 'number'
        && isFinite(result[key]) && result[key] > 0);
}

function runStamp(at) {
    const date = new Date(at), pad = (v) => String(v).padStart(2, '0');
    return pad(date.getDate()) + '.' + pad(date.getMonth() + 1) + '.' + date.getFullYear()
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

// The five timed sections shown in DRAG HISTORY (matches the live sheet rows).
function sectionsFor(s) {
    const mph = s.speedUnit === 'mph';
    const speed = mph ? [
        { key: '0-60mph', label: '0–60 MPH', icon: 'SPEED' },
        { key: '60-130mph', label: '60–130 MPH', icon: 'SPEED' },
        { key: '0-100mph', label: '0–100 MPH', icon: 'SPEED' },
    ] : [
        { key: '0-100', label: '0–100 KM/H', icon: 'SPEED' },
        { key: '100-200', label: '100–200 KM/H', icon: 'SPEED' },
        { key: '200-300', label: '200–300 KM/H', icon: 'SPEED' },
    ];
    return speed.concat([
        { key: 'qm', label: '1/4 MILE', icon: 'FLAG' },
        { key: 'em', label: '1/8 MILE', icon: 'FLAG' },
    ]);
}

function slab(cv, G, y0, y1) {
    const h = y1 - y0;
    const slabX = 294, slabW = 740, slabS = Math.round(SLANT * (h - 12) / h);
    Sheet.para(cv, slabX, y0 + 8, slabW, y1 - 4, slabS, '#000000');
    cv.line(slabX, y0 + 8, slabX + slabW, y0 + 8, 2, G.withAlpha('#f32635', 0.4));
    cv.line(slabX, y0 + 8, slabX - slabS, y1 - 4, 1.5, G.withAlpha('#f32635', 0.25));
    cv.line(slabX + slabW - slabS, y1 - 4, slabX + slabW, y0 + 8, 1.5, G.withAlpha('#f32635', 0.25));
    return { x: slabX, w: slabW };
}

function ribbon(cv, G, y0, y1) {
    const ribX = 1128;
    Sheet.para(cv, ribX,       y0, 210, y1, SLANT, '#2a0b12');
    Sheet.para(cv, ribX + 210, y0, 112, y1, SLANT, '#1b070c');
    Sheet.para(cv, ribX + 322, y0, 62,  y1, SLANT, '#8c1122');
    Sheet.para(cv, ribX + 384, y0, 56,  y1, SLANT, '#d91c33');
    return ribX;
}

// VALID/INVALID stamp artwork: ink blended at 50% over the background it is drawn on,
// so the sticker is translucent and has no boxed background.
let stampSetImage;
const stampCache = {};
function stampArt(valid, bg) {
    bg = bg || '#2a0b12';
    const key = (valid ? 'v' : 'i') + bg;
    if (key in stampCache) return stampCache[key];
    let art = null;
    try {
        const CarImages = require('./car_images');
        if (!stampSetImage) {
            try { stampSetImage = require('./kit/record').setImage; }
            catch (e) { stampSetImage = require('../../kit/runtime/record').setImage; }
        }
        const png = CarImages.readAsset(valid ? 'ui/drag-valid-stamp.png' : 'ui/drag-invalid-stamp.png');
        const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
        const src = CarImages.decodePng(png, null, null, w, h, { alphaOnly: true });
        // The sticker PNGs have no real alpha: a baked black box sits behind the seal.
        // Decoded over black, ink pixels keep their luminance and the box stays 0 —
        // so luminance is the ink mask: black vanishes, the seal stays at ~50%.
        const lit = CarImages.decodePng(png, '#000000', null, w, h, {});
        const mask = new Uint8Array(w * h);
        for (let i = 0; i < mask.length; i++) {
            const lum = 0.2126 * lit.rgba[i * 4] + 0.7152 * lit.rgba[i * 4 + 1] + 0.0722 * lit.rgba[i * 4 + 2];
            const ink = Math.max(0, Math.min(255, Math.round((lum - 12) * 255 / 60)));
            mask[i] = Math.round(src.alpha[i] * ink / 255 / 2);
        }
        const d = CarImages.decodePng(png, bg, mask, w, h, { omitAlpha: false });
        let x0 = w, y0 = h, x1 = 0, y1 = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            if (d.alpha[y * w + x] > 32) {
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
        const m = 2;
        x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
        x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
        const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
        const cropped = new Uint8Array(cw * ch * 4);
        for (let y = 0; y < ch; y++) cropped.set(d.rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4), y * cw * 4);
        const id = (valid ? 0x5660 : 0x5661) + (bg === '#2a0b12' ? 0 : 4);
        stampSetImage(id, cw, ch, cropped);
        art = { id, w: cw, h: ch };
    } catch (e) { art = null; }
    stampCache[key] = art;
    return art;
}

function ribbonRows(cv, G, s, actions, ribX, y0, xAt, rows) {
    rows.forEach(([label, run, key, fkey, armed], i) => {
        const ry = y0 + 68 + i * 106;
        const rx = xAt(ribX + 26, ry);
        const redBar = armed || (s.flashKey === fkey && Date.now() - s.flashAt < 1000);
        const ic = redBar ? '#ffffff' : G.withAlpha('#c8ced8', 0.78);
        cv.text(label, rx + 4, ry + 8, 21, ic, { font: 'bold', spacing: 1.2, literal: true });
        Sheet.drawBarSegs(cv, G, rx + 4, ry + 18, redBar);
        if (cv.own && run) cv.target(rx - 18, ry - 22, 348, 64,
            () => { if (actions && actions.flash) actions.flash(fkey); run(); }, key, 10, true);
    });
}

function drawCar(cv, t, car, rect) {
    if (!car || !car.imageId || !(car.width > 0) || !(car.height > 0)) {
        cv.text('SIDE VIEW UNAVAILABLE', rect.x + rect.w / 2, rect.y + rect.h / 2, 14, t.dim,
            { align: 'center', font: 'bold', literal: true });
        return;
    }
    const image = contain(rect, car.width, car.height);
    cv.image(car.imageId, image.x, image.y, image.w, image.h);
}

// Speed-over-time chart sheared to the stage's diagonal (same language as the dyno graph).
// `marks` = optional km/h levels drawn as dashed reference lines (split from/to speeds).
function traceChart(cv, G, t, s, trace, rect, marks) {
    const unit = s.speedUnit || 'kmh';
    const factor = unit === 'mph' ? 1 / 1.609344 : 1;
    const points = DragRun.compactTrace(trace || [], DragRun.MAX_TRACE_POINTS);
    const tMax = Math.max(8, Math.ceil((points.length ? points[points.length - 1][0] : 0) / 2) * 2);
    const maxSpeed = points.reduce((max, point) => Math.max(max, point[1] * factor), 0);
    const vMax = Math.max(unit === 'mph' ? 100 : 160, Math.ceil((maxSpeed + 10) / 40) * 40);
    const x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    const sh = Math.round(h * 0.27);
    const sx = (px, py) => px - (py - y) / h * sh;
    const X = (sec) => x + Math.max(0, Math.min(tMax, sec)) / tMax * w;
    const Y = (spd) => y + h - Math.max(0, Math.min(vMax, spd * factor)) / vMax * h;
    const shearPt = (p) => [p[0] - (p[1] - y) / h * sh, p[1]];

    cv.quad([[x, y], [x + w, y], [x + w - sh, y + h], [x - sh, y + h]], '#0A0F17');
    cv.line(x, y, x + w, y, 1, G.withAlpha('#A9B8CC', 0.16));
    cv.line(x - sh, y + h, x + w - sh, y + h, 1, G.withAlpha('#A9B8CC', 0.16));
    cv.line(x, y, x - sh, y + h, 1, G.withAlpha('#A9B8CC', 0.16));
    cv.line(x + w, y, x + w - sh, y + h, 1, G.withAlpha('#A9B8CC', 0.16));

    for (let i = 0; i <= 5; i++) {
        const fraction = i / 5;
        const yy = y + h * fraction;
        cv.line(sx(x, yy), yy, sx(x + w, yy), yy, 1, G.withAlpha(t.tick, i === 5 ? 0.5 : 0.24));
        cv.line(sx(x - 5, yy), yy, sx(x, yy), yy, 1.5, G.withAlpha(RED, 0.8));
        cv.text(String(Math.round(vMax * (1 - fraction))), sx(x - 12, yy), yy + 5, 15, RED,
            { align: 'right', font: 'bold' });
    }
    const step = tMax > 20 ? 5 : 2;
    for (let sec = 0; sec <= tMax; sec += step) {
        const xx = X(sec);
        cv.line(sx(xx, y), y, sx(xx, y + h), y + h, 1, G.withAlpha(t.tick, 0.18));
        cv.line(sx(xx, y + h), y + h, sx(xx, y + h), y + h + 5, 1.5, G.withAlpha(t.dim, 0.75));
        cv.text(sec + 's', sx(xx, y + h), y + h + 20, 12, t.dim, { align: 'center', font: 'bold' });
    }
    cv.text(unit === 'mph' ? 'MPH' : 'KM/H', x - 12, y - 12, 12, RED, { align: 'right', font: 'bold' });
    cv.text('TIME · SECONDS', sx(x + w / 2, y + h), y + h + 42, 13, t.dim,
        { align: 'center', font: 'bold', spacing: 0.8, literal: true });
    cv.line(sx(x, y + h), y + h, sx(x + w, y + h), y + h, 2, G.withAlpha('#ffffff', 0.68));

    (marks || []).forEach((m) => {
        const yy = Y(m);
        if (yy > y + 8 && yy < y + h - 8) {
            cv.line(sx(x, yy), yy, sx(x + w, yy), yy, 1.5, G.withAlpha('#ff8595', 0.5));
            cv.text(String(Math.round(m * factor)), sx(x + w, yy) - 8, yy - 6, 12, '#ff8595',
                { align: 'right', font: 'bold' });
        }
    });

    if (points.length > 1) {
        const line = points.map((point) => shearPt([X(point[0]), Y(point[1])]));
        cv.fillUnder(line, y + h, G.withAlpha(RED, 0.12));
        cv.polyline(line, 7, G.withAlpha(RED, 0.14));
        cv.polyline(line, 3.4, RED);
        const last = line[line.length - 1];
        cv.circle(last[0], last[1], 8, G.withAlpha('#071019', 0.94));
        cv.circle(last[0], last[1], 6, G.withAlpha('#FFFFFF', 0.96));
        cv.circle(last[0], last[1], 3.5, RED);
    } else {
        const cx = sx(x + w / 2, y + 100);
        cv.text(s.timerState === 'ready' ? 'LAUNCH WHEN READY' : 'WAITING FOR ACCELERATION', cx, y + 100,
            22, t.dim, { align: 'center', font: 'bold', spacing: 1.1, literal: true });
        cv.text('hold brake · full throttle · release to launch', cx, y + 130, 14, t.dim,
            { align: 'center', literal: true });
    }
}

// Live sheet: same shell as DYNO RUN — tag, chips, slanted stage with the trace,
// right ribbon with result rows and the status block.
function drawSheet(cv, G, t, s, car, actions) {
    const y0 = (G.TOP || 44) + 8, y1 = H - 8, h = y1 - y0;
    const xAt = (xTop, y) => xTop - (y - y0) / h * SLANT;
    const isRun = s.timerState === 'run';
    const current = isRun ? s.currentRun : s.selectedRun;
    const hasData = !!(current || isRun);
    const splits = s.splits || [];
    const sprint = splits[1] || { key: '0-100', label: '0–100 KM/H' };
    const distSplit = splits.find((sp) => sp.dist) || { key: 'qm', label: s.distanceLabel || '1/4 MILE' };
    const unitL = s.speedUnit === 'mph' ? 'MPH' : 'KM/H';

    // 1. Backdrop + hex mesh
    cv.fillRect(0, y0, W, h, t.bg);
    Sheet.drawHexMesh(cv, G, y0, y1, false);

    // 2. Slanted black stage — identical geometry to the DYNO sheet
    const slabX = 294, slabW = 740, slabS = Math.round(SLANT * (h - 12) / h);
    Sheet.para(cv, slabX, y0 + 8, slabW, y1 - 4, slabS, '#000000');
    cv.line(slabX, y0 + 8, slabX + slabW, y0 + 8, 2, G.withAlpha('#f32635', 0.4));
    cv.line(slabX, y0 + 8, slabX - slabS, y1 - 4, 1.5, G.withAlpha('#f32635', 0.25));
    cv.line(slabX + slabW - slabS, y1 - 4, slabX + slabW, y0 + 8, 1.5, G.withAlpha('#f32635', 0.25));

    cv.text('ACCELERATION TRACE', 316, y0 + 36, 15, t.dim, { font: 'bold', spacing: 1.4, literal: true });
    cv.roundRect(316, y0 + 56, 18, 5, 2, RED);
    cv.text('SPEED', 341, y0 + 63, 12, t.dim, { font: 'bold', spacing: 0.5, literal: true });
    traceChart(cv, G, t, s, isRun ? s.trace : (current && current.trace), { x: 338, y: y0 + 106, w: 560, h: 270 });
    drawCar(cv, t, car, { x: 820, y: y0 + 14, w: 175, h: 88 });

    // 3. Title tag and actions
    const tagX = 40, tagY = y0 + 24, tagW = Sheet.titleTagWidth(cv, 'DRAG RUN', 27, 196), tagH = 46, tagSlant = 15;
    Sheet.para(cv, tagX, tagY, tagW, tagY + tagH, tagSlant, G.withAlpha('#c8192b', 0.94));
    cv.text('DRAG RUN', tagX + (tagW - tagSlant) / 2, tagY + 34, 27, '#ffffff',
        { align: 'center', font: 'num', spacing: 1.6, literal: true });
    Sheet.drawChip(cv, G, tagX, tagY + tagH + 14, 196, 'DRAG HISTORY',
        { icon: 'fwd', run: actions && actions.toggleView, key: 'performance_drag_runs' });
    Sheet.drawChip(cv, G, tagX, tagY + tagH + 68, 118, 'RESET',
        { icon: 'reset', run: actions && actions.reset, key: 'performance_drag_reset' });

    // 4. Right ribbon — same diagonal bands as DYNO RUN
    const ribX = 1128;
    Sheet.para(cv, ribX,       y0, 210, y1, SLANT, '#2a0b12');
    Sheet.para(cv, ribX + 210, y0, 112, y1, SLANT, '#1b070c');
    Sheet.para(cv, ribX + 322, y0, 62,  y1, SLANT, '#8c1122');
    Sheet.para(cv, ribX + 384, y0, 56,  y1, SLANT, '#d91c33');

    // VALID/INVALID sticker at the right of the timing values: it sits inside the dark
    // ribbon band (baked on that band's colour, 50% ink), beside the first rows.
    const hasLiveTimes = hasTimedResults(current) || Object.keys(s.rolling || {}).some((key) =>
        typeof s.rolling[key] === 'number' && isFinite(s.rolling[key]) && s.rolling[key] > 0);
    const liveStamp = hasLiveTimes ? stampArt(s.slope == null || s.slope >= -1.0, '#1b070c') : null;
    if (liveStamp) {
        const ih = 120, iw = Math.round(ih * liveStamp.w / liveStamp.h);
        const iy = y0 + 26;
        cv.image(liveStamp.id, xAt(ribX + 266, iy + ih / 2) - iw / 2, iy, iw, ih);
    }

    // 5. Result rows: the five timed splits — speed intervals then the two mile marks
    const res = (key) => {
        const v = current && current.result && current.result[key];
        return v != null ? v : s.rolling && s.rolling[key];
    };
    const bestOf = (key) => s.best && s.best[DragRun.bestKey(key, s.speedUnit, !!s.rollout)];
    const speedDefs = s.speedUnit === 'mph' ? [
        ['0-60mph', '0–60 MPH'], ['60-130mph', '60–130 MPH'], ['0-100mph', '0–100 MPH'],
    ] : [
        ['0-100', '0–100 KM/H'], ['100-200', '100–200 KM/H'], ['200-300', '200–300 KM/H'],
    ];
    const detail = (key) => isRun ? 'TIMING…'
        : bestOf(key) ? 'BEST ' + DragRunSeconds(bestOf(key).s) + ' S' : '';
    const rows = speedDefs.map(([key, label]) => ['SPEED', label,
        res(key) != null ? DragRunSeconds(res(key)) + ' S' : '--.--', detail(key), RED, res(key) != null]);
    [['qm', '1/4 MILE'], ['em', '1/8 MILE']].forEach(([key, label]) => {
        const trapV = current && current.trap && current.trap[key];
        rows.push(['FLAG', label, res(key) != null ? DragRunSeconds(res(key)) + ' S' : '--.--',
            isRun ? 'TIMING…' : trapV ? 'TRAP ' + number(DragRunSpeed(trapV, s.speedUnit), 0) + ' ' + unitL
                : detail(key), RED, res(key) != null]);
    });
    rows.forEach(([iconKey, label, value, detail, color, ok], i) => {
        const rowOk = ok === undefined ? hasData : ok;
        const ry = y0 + 34 + i * 78;
        const rx = xAt(ribX + 26, ry);
        Sheet.modeIcon(cv, G, t, iconKey, rx + 12, ry + 14, 34,
            rowOk ? G.withAlpha('#c8ced8', 0.9) : G.withAlpha('#c8ced8', 0.5));
        cv.text(label, rx + 46, ry, 15, G.withAlpha('#e8c8ce', 0.55),
            { font: 'bold', spacing: 1.0, literal: true });
        cv.text(value, rx + 46, ry + 33, 30, rowOk ? color : G.withAlpha('#8c94a0', 0.5),
            { font: 'num', spacing: 0.5, literal: true });
        if (detail) cv.text(detail, rx + 46, ry + 52, 11, G.withAlpha('#e8c8ce', 0.42),
            { font: 'bold', spacing: 0.4, literal: true });
    });

    // 6. Status block — pulsing green READY TO LAUNCH when armed (like draggy),
    // otherwise the red timing / standby state.
    const setupY = y1 - 84, setupX = xAt(ribX + 12, setupY);
    const ready = s.timerState === 'ready';
    if (ready) {
        const btnY = setupY + 30, bx = xAt(ribX + 12, btnY);
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 160);
        const bw = 198, bh = 34;
        Sheet.para(cv, bx, btnY, bw, btnY + bh, 10,
            G.withAlpha('#2ee06f', 0.10 + 0.12 * pulse));
        cv.line(bx, btnY, bx + bw, btnY, 2,
            G.withAlpha('#2ee06f', 0.35 + 0.55 * pulse));
        cv.line(bx + bw - 10, btnY + bh, bx - 10, btnY + bh, 2,
            G.withAlpha('#2ee06f', 0.2 + 0.3 * pulse));
        cv.circle(bx + 18, btnY + bh / 2, 3.6,
            Math.floor(Date.now() / 300) % 2 ? '#2ee06f' : G.withAlpha('#2ee06f', 0.3));
        cv.text('READY TO LAUNCH', bx + bw / 2 + 6, btnY + bh / 2 + 6, 16, '#2ee06f',
            { align: 'center', font: 'bold', spacing: 1.2, literal: true });
    } else {
        const stateLabel = isRun ? 'TIMING' : 'STANDBY';
        cv.text('STATE · ' + stateLabel, setupX, setupY + 14, 20, '#ffffff',
            { font: 'bold', spacing: 1.1, literal: true });
        if (isRun) {
            const tw = cv.textWidth('STATE · TIMING', 20, { font: 'bold', spacing: 1.1 });
            cv.circle(setupX + tw + 18, setupY + 8, 5,
                Math.floor(Date.now() / 300) % 2 ? '#ff243b' : G.withAlpha('#ff243b', 0.3));
        }
        const sub = isRun
            ? (typeof s.elapsed === 'number' ? s.elapsed.toFixed(2) + ' S ELAPSED' : 'TIMING…')
            : current ? runStamp(current.at) : 'STOP TO ARM · HOLD BRAKE';
        cv.text(sub, setupX, setupY + 40, 13, '#ff8595', { font: 'bold', spacing: 0.8, literal: true });
        cv.text(s.demo ? 'DEMO · TIMING PAUSED' : (s.rollout ? 'ROLLOUT 1 FT · ' : '') + 'FULL THROTTLE LAUNCH',
            setupX, setupY + 64, 10.5, G.withAlpha('#e8c8ce', 0.5), { font: 'bold', spacing: 0.5, literal: true });
    }
}

// History level 1 — the five timed sections, each showing how many runs contain it.
function drawSections(cv, G, t, s, actions) {
    const y0 = (G.TOP || 44) + 8, y1 = H - 8, h = y1 - y0;
    const xAt = (xTop, y) => xTop - (y - y0) / h * SLANT;
    const unit = s.speedUnit || 'kmh';
    const runs = (s.runs || []).filter((run) => (run.unit || 'kmh') === unit);

    cv.fillRect(0, y0, W, h, t.bg);
    Sheet.drawHexMesh(cv, G, y0, y1, false);
    slab(cv, G, y0, y1);

    cv.text('DRAG HISTORY', 316, y0 + 36, 15, t.dim, { font: 'bold', spacing: 1.4, literal: true });
    cv.text(runs.length + (runs.length === 1 ? ' SAVED RUN' : ' SAVED RUNS'), 316, y0 + 58, 12,
        G.withAlpha('#ff8595', 0.75), { font: 'bold', spacing: 0.6, literal: true });

    sectionsFor(s).forEach((sec, i) => {
        const count = runs.filter((run) => run.result && run.result[sec.key] != null).length;
        const best = s.best && s.best[DragRun.bestKey(sec.key, unit, !!s.rollout)];
        const ry = y0 + 100 + i * 78;
        const rx = 330;
        if (i) cv.line(320, ry - 42, 900, ry - 42, 1, G.withAlpha('#ff8595', 0.1));
        Sheet.modeIcon(cv, G, t, sec.icon, rx + 12, ry - 4, 32,
            count ? G.withAlpha('#c8ced8', 0.9) : G.withAlpha('#c8ced8', 0.38));
        cv.text(sec.label, rx + 52, ry + 4, 21,
            count ? '#ffffff' : G.withAlpha('#e8c8ce', 0.45),
            { font: 'bold', spacing: 1.2, literal: true });
        cv.text(count + (count === 1 ? ' RECORD' : ' RECORDS'), rx + 52, ry + 30, 12,
            G.withAlpha('#e8c8ce', 0.5), { font: 'bold', spacing: 0.6, literal: true });
        cv.text(best ? DragRunSeconds(best.s) + ' S' : '--.--', 900, ry + 10, 26,
            best ? '#ff243b' : G.withAlpha('#8c94a0', 0.45),
            { align: 'right', font: 'num', literal: true });
        cv.text('BEST', 900, ry + 30, 11,
            best ? G.withAlpha('#ff8595', 0.7) : G.withAlpha('#e8c8ce', 0.3),
            { align: 'right', font: 'bold', spacing: 0.8, literal: true });
        if (cv.own && count && actions && actions.openSection) {
            cv.target(300, ry - 38, 640, 72,
                () => actions.openSection(sec.key), 'performance_dragsec_' + sec.key, 10, true);
        }
    });

    // Title tag and clear-history action
    const tagX = 40, tagY = y0 + 24, tagW = Sheet.titleTagWidth(cv, 'DRAG RUNS', 27, 216), tagH = 46, tagSlant = 15;
    Sheet.para(cv, tagX, tagY, tagW, tagY + tagH, tagSlant, G.withAlpha('#c8192b', 0.94));
    cv.text('DRAG RUNS', tagX + (tagW - tagSlant) / 2, tagY + 34, 27, '#ffffff',
        { align: 'center', font: 'num', spacing: 1.6, literal: true });
    Sheet.drawChip(cv, G, tagX, tagY + tagH + 14, 196,
        s.clearArmed ? 'CONFIRM CLEAR' : 'CLEAR HISTORY',
        { icon: 'reset', run: actions && actions.clear, key: 'performance_dragsecs_clear' });

    // Right ribbon — the five best results
    const ribX = ribbon(cv, G, y0, y1);
    sectionsFor(s).forEach((sec, i) => {
        const best = s.best && s.best[DragRun.bestKey(sec.key, unit, !!s.rollout)];
        const ry = y0 + 44 + i * 74;
        const rx = xAt(ribX + 26, ry);
        Sheet.modeIcon(cv, G, t, sec.icon, rx + 10, ry + 12, 28,
            best ? G.withAlpha('#c8ced8', 0.85) : G.withAlpha('#c8ced8', 0.4));
        cv.text('BEST ' + sec.label.replace(/ KM\/H| MPH/g, ''), rx + 42, ry, 14,
            G.withAlpha('#e8c8ce', best ? 0.55 : 0.35),
            { font: 'bold', spacing: 1.0, literal: true });
        cv.text(best ? DragRunSeconds(best.s) + ' S' : '--.--', rx + 42, ry + 28, 26,
            best ? '#ff243b' : G.withAlpha('#8c94a0', 0.4),
            { font: 'num', spacing: 0.5, literal: true });
    });
}

function crown(cv, cx, cy, c) {
    cv.quad([[cx - 11, cy + 7], [cx + 11, cy + 7], [cx + 9, cy + 3], [cx - 9, cy + 3]], c);
    cv.line(cx - 11, cy + 3, cx - 12, cy - 6, 2.2, c);
    cv.line(cx - 12, cy - 6, cx - 5, cy, 2.2, c);
    cv.line(cx - 5, cy, cx, cy - 8, 2.2, c);
    cv.line(cx, cy - 8, cx + 5, cy, 2.2, c);
    cv.line(cx + 5, cy, cx + 12, cy - 6, 2.2, c);
    cv.line(cx + 12, cy - 6, cx + 11, cy + 3, 2.2, c);
    cv.circle(cx - 12, cy - 7, 1.8, c);
    cv.circle(cx, cy - 9, 2.0, c);
    cv.circle(cx + 12, cy - 7, 1.8, c);
}

const RUNS_PER_PAGE = 5;

// History level 2 — runs that contain the picked section, Dragy-style rows, numbered + paged.
function drawRuns(cv, G, t, s, actions) {
    const y0 = (G.TOP || 44) + 8, y1 = H - 8, h = y1 - y0;
    const xAt = (xTop, y) => xTop - (y - y0) / h * SLANT;
    const unit = s.speedUnit || 'kmh';
    const sec = sectionsFor(s).find((x) => x.key === s.section) || sectionsFor(s)[0];
    const all = (s.runs || []).filter((run) => (run.unit || 'kmh') === unit
        && run.result && run.result[sec.key] != null);
    const pages = Math.max(1, Math.ceil(all.length / RUNS_PER_PAGE));
    const pg = Math.max(0, Math.min(pages - 1, s.runsPage || 0));
    const selRun = all.find((run) => run.at === s.selectedAt) || all[0] || null;
    const shown = all.slice(pg * RUNS_PER_PAGE, pg * RUNS_PER_PAGE + RUNS_PER_PAGE);
    const best = s.best && s.best[DragRun.bestKey(sec.key, unit, !!s.rollout)];

    cv.fillRect(0, y0, W, h, t.bg);
    Sheet.drawHexMesh(cv, G, y0, y1, false);
    slab(cv, G, y0, y1);

    cv.text(sec.label + ' · RUNS', 316, y0 + 36, 15, t.dim,
        { font: 'bold', spacing: 1.4, literal: true });
    cv.text(all.length + (all.length === 1 ? ' RECORD' : ' RECORDS')
        + (best ? '   ·   BEST ' + DragRunSeconds(best.s) + ' S' : ''),
        316, y0 + 58, 12, G.withAlpha('#ff8595', 0.75), { font: 'bold', spacing: 0.6, literal: true });

    if (!shown.length) {
        cv.text('NO RUNS YET', 610, y0 + 236, 20, t.dim,
            { align: 'center', font: 'bold', spacing: 1.1, literal: true });
        cv.text('THIS SECTION HAS NO SAVED RESULTS', 610, y0 + 264, 12,
            G.withAlpha('#e8c8ce', 0.45), { align: 'center', font: 'bold', spacing: 0.6, literal: true });
    }
    shown.forEach((run, i) => {
        const ry = y0 + 108 + i * 68;
        const sel = selRun && run.at === selRun.at;
        const isBest = best && best.at === run.at;
        if (sel) {
            Sheet.para(cv, 306, ry - 30, 616, ry + 34, 20, G.withAlpha('#ffffff', 0.1));
            Sheet.para(cv, 306, ry - 30, 6, ry + 34, 20, '#ff243b');
        }
        const rowNo = pg * RUNS_PER_PAGE + i + 1;
        cv.text('#' + rowNo, 336, ry + 8, 18,
            sel ? '#ff243b' : G.withAlpha('#c8ced8', 0.45),
            { font: 'num', spacing: 0.5, literal: true });
        cv.text(runStamp(run.at), 388, ry, 18, sel ? '#ffffff' : G.withAlpha('#e8c8ce', 0.85),
            { font: 'bold', spacing: 0.8, literal: true });
        const trapV = run.trap && run.trap[sec.key];
        const uStr = unit === 'mph' ? 'mph' : 'km/h';
        const peakG = run.peakG != null ? run.peakG : DragRun.peakGFromTrace(run.trace);
        const parts = [];
        if (trapV) parts.push('TRAP ' + number(DragRunSpeed(trapV, unit), 0) + ' ' + uStr);
        if (peakG != null) parts.push('G PEAK ' + number(peakG, 2));
        if (run.vmax != null) parts.push('SPEED ' + number(DragRunSpeed(run.vmax, unit), 0) + uStr);
        cv.text(parts.join('   ·   '), 388, ry + 26, 14, G.withAlpha('#e8c8ce', 0.6),
            { font: 'bold', spacing: 0.5, literal: true });
        const secT = run.result && run.result[sec.key];
        const secTxt = secT != null ? DragRunSeconds(secT) + ' S' : '--.--';
        cv.text(secTxt, 856, ry + 14, 28,
            isBest ? '#ff243b' : '#ffffff', { align: 'right', font: 'num', literal: true });
        if (isBest) {
            const vw = cv.textWidth(secTxt, 28, { font: 'num', spacing: 0.5 });
            const bw = 54, bx = 856 - vw - 14 - bw;
            Sheet.para(cv, bx, ry - 2, bw, ry + 18, 8, '#c8192b');
            cv.text('BEST', bx + bw / 2 - 4, ry + 13, 12, '#ffffff',
                { align: 'center', font: 'bold', spacing: 0.8, literal: true });
        }
        if (cv.own && actions && actions.openReport) {
            cv.target(300, ry - 30, 632, 64,
                () => actions.openReport(run.at), 'performance_dragrun_' + i, 10, true);
        }
    });

    // Bottom-right page arrows inside the slab — ‹ prev · PAGE x/y · › next
    if (pages > 1) {
        const ay = y1 - 44, aw = 58, ah = 34;
        const chev = (cx, dir) => {
            const ox = dir > 0 ? -6 : 6;
            cv.line(cx + ox, ay + 8, cx - ox, ay + ah / 2, 2.6, '#ffffff');
            cv.line(cx - ox, ay + ah / 2, cx + ox, ay + ah - 8, 2.6, '#ffffff');
        };
        const nx = 808;
        if (pg > 0) {
            Sheet.para(cv, nx - aw - 14, ay, aw, ay + ah, 10, G.withAlpha('#ffffff', 0.1));
            chev(nx - aw - 14 + aw / 2, -1);
            if (cv.own && actions && actions.runsPage)
                cv.target(nx - aw - 14, ay - 3, aw, ah + 6, () => actions.runsPage(-1), 'performance_runs_prev', 10);
        }
        if (pg < pages - 1) {
            Sheet.para(cv, nx, ay, aw, ay + ah, 10, '#c8192b');
            chev(nx + aw / 2, 1);
            if (cv.own && actions && actions.runsPage)
                cv.target(nx, ay - 3, aw, ah + 6, () => actions.runsPage(1), 'performance_runs_next', 10);
        }
        cv.text('PAGE ' + (pg + 1) + ' / ' + pages, nx - aw - 30, ay + 23, 12,
            G.withAlpha('#e8c8ce', 0.5), { align: 'right', font: 'bold', spacing: 0.8, literal: true });
    }

    // Title tag and clear-section action
    const shortName = sec.label.replace(/ KM\/H| MPH/g, '');
    const tagX = 40, tagY = y0 + 24, tagW = Sheet.titleTagWidth(cv, 'DRAG RUNS', 27, 216), tagH = 46, tagSlant = 15;
    Sheet.para(cv, tagX, tagY, tagW, tagY + tagH, tagSlant, G.withAlpha('#c8192b', 0.94));
    cv.text('DRAG RUNS', tagX + (tagW - tagSlant) / 2, tagY + 34, 27, '#ffffff',
        { align: 'center', font: 'num', spacing: 1.6, literal: true });
    const clearLines = s.clearArmed ? ['CONFIRM CLEAR'] : ['CLEAR ' + shortName, 'HISTORY'];
    Sheet.drawChip(cv, G, tagX, tagY + tagH + 14, 242,
        clearLines.join(' '),
        { icon: 'reset', run: actions && actions.clearSection, key: 'performance_dragruns_clear', lines: clearLines });

    // Right ribbon — TOP 3 RUNS leaderboard (crown on #1)
    const ribX = ribbon(cv, G, y0, y1);
    const topX = xAt(ribX + 26, y0 + 36);
    cv.text('TOP 3 RUNS', topX + 4, y0 + 44, 17, '#ffffff',
        { font: 'bold', spacing: 1.4, literal: true });
    cv.text(sec.label, topX + 4, y0 + 64, 11.5, G.withAlpha('#ff8595', 0.75),
        { font: 'bold', spacing: 0.8, literal: true });
    const top3 = all.slice().sort((a, b) => a.result[sec.key] - b.result[sec.key]).slice(0, 3);
    [0, 1, 2].forEach((i) => {
        const r = top3[i];
        const ry = y0 + 108 + i * 92;
        const rx = xAt(ribX + 26, ry);
        if (i === 0) crown(cv, rx + 14, ry + 8, r ? '#ffc738' : G.withAlpha('#8c94a0', 0.4));
        else cv.text('#' + (i + 1), rx + 14, ry + 14, 17,
            r ? G.withAlpha('#c8ced8', 0.75) : G.withAlpha('#8c94a0', 0.35),
            { align: 'center', font: 'bold', literal: true });
        cv.text(r ? DragRunSeconds(r.result[sec.key]) + ' S' : '--.--', rx + 40, ry + 20, 28,
            !r ? G.withAlpha('#8c94a0', 0.4) : i === 0 ? '#ffc738' : '#ff243b',
            { font: 'num', spacing: 0.5, literal: true });
        if (r) cv.text(runStamp(r.at), rx + 40, ry + 40, 11,
            G.withAlpha('#e8c8ce', 0.5), { font: 'bold', spacing: 0.5, literal: true });
        if (cv.own && r && actions && actions.openReport) {
            cv.target(rx - 12, ry - 16, 300, 68,
                () => actions.openReport(r.at), 'performance_dragtop_' + i, 10, true);
        }
    });
}

// Interpolate crossing time of `kmh` along a [[sec, kmh], ...] trace.
function crossAt(trace, kmh) {
    const tr = trace || [];
    for (let i = 1; i < tr.length; i++) {
        const [t0, v0] = tr[i - 1], [t1, v1] = tr[i];
        if (v0 <= kmh && v1 >= kmh) {
            return v1 === v0 ? t1 : t0 + (kmh - v0) / (v1 - v0) * (t1 - t0);
        }
    }
    return tr.length && Math.abs(tr[0][1] - kmh) < 0.5 ? tr[0][0] : null;
}

// Interpolate time when integrated distance reaches `targetM` metres.
function distAt(trace, targetM) {
    const tr = trace || [];
    let d = 0;
    for (let i = 1; i < tr.length; i++) {
        const [t0, v0] = tr[i - 1], [t1, v1] = tr[i];
        const seg = ((v0 + v1) / 2 / 3.6) * (t1 - t0);
        if (d + seg >= targetM) {
            return seg > 0 ? t0 + (targetM - d) / seg * (t1 - t0) : t1;
        }
        d += seg;
    }
    return null;
}

// Ten Dragy-style sub-splits for the active section (5 left + 5 right in the ribbon).
function subSplitsFor(secKey, run) {
    const tr = run && run.trace || [];
    const speedSpan = (from, to, step, factor, tag) => {
        const out = [], tStart = from === 0 ? 0 : crossAt(tr, from * factor);
        for (let v = from + step; v <= to + 1e-6; v += step) {
            const tEnd = crossAt(tr, v * factor);
            const dt = tStart != null && tEnd != null && tEnd >= tStart ? tEnd - tStart : null;
            out.push([from + '–' + Math.round(v) + (tag || ''), dt]);
        }
        return out;
    };
    const M = DragRun.MPH_KMH;
    if (secKey === '0-100') return speedSpan(0, 100, 10, 1);
    if (secKey === '100-200') return speedSpan(100, 200, 10, 1);
    if (secKey === '200-300') return speedSpan(200, 300, 10, 1);
    if (secKey === '0-60mph') return speedSpan(0, 60, 10, M);
    if (secKey === '60-130mph') return speedSpan(60, 130, 10, M);
    if (secKey === '0-100mph') return speedSpan(0, 100, 10, M);
    const marks = secKey === 'em'
        ? [['60 FT', 18.288], ['100 M', 100], ['330 FT', 100.584], ['150 M', 150], ['1/8 MI', 201.168]]
        : [['60 FT', 18.288], ['330 FT', 100.584], ['1/8 MI', 201.168], ['1000 FT', 304.8],
           ['300 M', 300], ['1/4 MI', 402.336]];
    return marks.map(([lbl, m]) => [lbl, distAt(tr, m)]);
}

// History level 3 — Dragy-style performance report: speed trace + stat tiles.
function drawReport(cv, G, t, s, actions) {
    const y0 = (G.TOP || 44) + 8, y1 = H - 8, h = y1 - y0;
    const xAt = (xTop, y) => xTop - (y - y0) / h * SLANT;
    const unit = s.speedUnit || 'kmh';
    const run = s.selectedRun;
    const sec = sectionsFor(s).find((x) => x.key === s.section) || sectionsFor(s)[0];

    cv.fillRect(0, y0, W, h, t.bg);
    Sheet.drawHexMesh(cv, G, y0, y1, false);
    slab(cv, G, y0, y1);

    cv.text('PERFORMANCE REPORT', 316, y0 + 36, 15, t.dim, { font: 'bold', spacing: 1.4, literal: true });
    cv.text(run ? runStamp(run.at) : '',
        316, y0 + 48, 12, G.withAlpha('#ff8595', 0.75), { font: 'bold', spacing: 0.6, literal: true });

    // Compact chart (h=190) so TIME · SECONDS at y0+314 clears the stat tiles at y0+358.
    const secDef = (s.splits || []).find((sp) => sp.key === sec.key);
    const marks = secDef && !secDef.dist ? [secDef.from, secDef.to] : null;
    traceChart(cv, G, t, s, run && run.trace, { x: 338, y: y0 + 82, w: 560, h: 190 }, marks);

    // Three stat tiles — distance (446.13m), split time (6.07s), slope (-0.45%).
    const splitS = run && run.result && run.result[sec.key];
    const distM = run && (run.dist != null ? run.dist
        : (run.trace || []).reduce((d, p, i, tr) =>
            i ? d + ((tr[i - 1][1] + p[1]) / 2 / 3.6) * (p[0] - tr[i - 1][0]) : d, 0));
    const distTxt = distM == null ? '--' : unit === 'mph'
        ? (distM * 3.28084).toFixed(2) + 'ft' : distM.toFixed(2) + 'm';
    const timeTxt = splitS != null ? DragRunSeconds(splitS) + 's' : '--.--';
    const slopeV = run && typeof run.slope === 'number' && isFinite(run.slope) ? run.slope : null;
    const slopeTxt = slopeV != null ? (slopeV > 0 ? '+' : '') + slopeV.toFixed(2) + '%' : '--';
    const tiles = [
        ['RULER', 'DISTANCE', distTxt],
        ['TIMER', sec.label, timeTxt],
        ['SLOPE', 'SLOPE', slopeTxt],
    ];
    tiles.forEach(([icon, cap, val], i) => {
        const tx = 316 + i * 204, ty = y0 + 358, tw = 190, th = 94;
        Sheet.para(cv, tx, ty, tw, ty + th, 16, G.withAlpha('#10141c', 0.85));
        cv.line(tx, ty, tx + tw, ty, 2, G.withAlpha('#f32635', 0.5));
        Sheet.modeIcon(cv, G, t, icon, tx + 22, ty + 20, 26, G.withAlpha('#c8ced8', 0.85));
        cv.text(cap, tx + 44, ty + 26, 12, G.withAlpha('#e8c8ce', 0.6),
            { font: 'bold', spacing: 0.8, literal: true });
        cv.text(val, tx + 18, ty + 72, 32, '#ffffff', { font: 'num', spacing: 0.5, literal: true });
    });

    // Left title tag and next-run action
    const tagX = 40, tagY = y0 + 24, tagW = Sheet.titleTagWidth(cv, 'REPORT', 27, 196), tagH = 46, tagSlant = 15;
    Sheet.para(cv, tagX, tagY, tagW, tagY + tagH, tagSlant, G.withAlpha('#c8192b', 0.94));
    cv.text('REPORT', tagX + (tagW - tagSlant) / 2, tagY + 34, 27, '#ffffff',
        { align: 'center', font: 'num', spacing: 1.6, literal: true });
    Sheet.drawChip(cv, G, tagX, tagY + tagH + 14, 156, 'NEXT RUN',
        { icon: 'fwd', run: actions && actions.nextRun, key: 'performance_dragreport_next' });

    // Right ribbon — VALID/INVALID stamp sticker + 2-column sub-split breakdown
    const ribX = ribbon(cv, G, y0, y1);
    const valid = slopeV == null || slopeV >= -1.0;
    const hasTimes = hasTimedResults(run);
    const stamp = hasTimes ? stampArt(valid) : null;
    if (stamp) {
        const ih = 140, iw = Math.round(ih * stamp.w / stamp.h);
        const iy = y0 + 22;
        cv.image(stamp.id, xAt(ribX + 105, iy + ih / 2) - iw / 2, iy, iw, ih);
    } else if (hasTimes) {
        const vCol = valid ? '#2ee06f' : '#ff243b';
        cv.text(valid ? 'VALID RUN' : 'INVALID RUN', xAt(ribX + 105, y0 + 60), y0 + 80, 22, vCol,
            { align: 'center', font: 'bold', spacing: 1.4, literal: true });
    }

    // Sub-split table: left column (first 5) + right column (next 5)
    const subs = subSplitsFor(sec.key, run);
    const half = Math.ceil(subs.length / 2);
    const headY = y0 + 178, headX = xAt(ribX + 22, headY);
    cv.text('SPLIT BREAKDOWN', headX, headY, 13, '#ffffff',
        { font: 'bold', spacing: 1.2, literal: true });
    subs.forEach(([lbl, dt], idx) => {
        const col = idx < half ? 0 : 1, row = idx % half;
        const ry = y0 + 208 + row * 50;
        const rx = xAt(ribX + 18, ry) + col * 138;
        cv.text(lbl, rx, ry, 12, G.withAlpha('#e8c8ce', 0.55),
            { font: 'bold', spacing: 0.6, literal: true });
        cv.text(dt != null ? dt.toFixed(2) + 's' : '--.--', rx, ry + 22, 21,
            dt != null ? '#ff243b' : G.withAlpha('#8c94a0', 0.4),
            { font: 'num', spacing: 0.4, literal: true });
    });
}

function draw(cv, G, t, s, car, actions) {
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'RACE MODES', 'CAR DATA', 'WARMUP'], 2, [
        s.demo && { text: 'DEMO · TIMING DISABLED', color: 'crit' },
    ]);
    G.sectionRule(cv, t, 24, G.TOP || 44, W - 48, t.stripes || RED);
    if (s.view === 'history') drawSections(cv, G, t, s, actions);
    else if (s.view === 'runs') drawRuns(cv, G, t, s, actions);
    else if (s.view === 'report') drawReport(cv, G, t, s, actions);
    else drawSheet(cv, G, t, s, car, actions);
    return cv;
}

module.exports = { W, H, draw, contain, traceChart, RUNS_PER_PAGE };
