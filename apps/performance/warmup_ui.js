'use strict';
/**
 * warmup_ui.js - the WARMUP page: engine warm-up state in the app's sheet shell
 * (hex mesh backdrop, slanted black slab, right value ribbon).
 *
 * Slab: status stamp + three temperature bars (oil / coolant / gearbox) with the
 * "warm" mark each, a 20-minute trend sparkline and a cold-starts strip.
 * Ribbon: OIL READY IN / COOLANT READY IN / GEARBOX READY IN / SAFE REV LIMIT /
 * TURBO COOL-DOWN.
 *
 * s = { temps: {oil, coolant, gearbox}, warm: {oil, coolant, gearbox},
 *       etas: {oil, coolant, gearbox}, status: {text, kind}, limit,
 *       cooldown: {active, left, done}, trend: [[t, oil, coolant, rpm, speed, gearbox]],
 *       coldStarts: {starts, cold, revved} }
 */
const Sheet = require('./flap_ui');

const W = 1600, H = 520;
const RED = '#f32635';
const GO = '#2fd27a';
const COLD = '#3d8bff';
const AMBER = '#ffb31a';
const SLANT = Sheet.SLANT;

const BAR_KEYS = [
    { key: 'oil', label: 'OIL TEMP' },
    { key: 'coolant', label: 'COOLANT TEMP' },
    { key: 'gearbox', label: 'GEARBOX OIL' },
];

/** A 270° temperature gauge: one fill colour per state (blue cold / red warm / bright red hot),
 *  a thin green rim notch at the warm point, red zone past ~118 °C. */
function tempGauge(cv, G, cx, cy, r, val, warm, label) {
    const A0 = -135, A1 = 135, MIN = 0, MAX = 150, thick = 10;
    const ang = (c) => A0 + Math.max(0, Math.min(1, (c - MIN) / (MAX - MIN))) * (A1 - A0);
    cv.arc(cx, cy, r - thick, r, A0, A1, G.withAlpha('#ffffff', 0.08), { round: true });
    cv.arc(cx, cy, r + 2, r + 5, ang(118), A1, G.withAlpha('#ff4a4a', 0.5));
    const live = typeof val === 'number' && isFinite(val);
    const isWarm = live && val >= warm;
    const hot = live && val >= 125;
    const col = !live ? '#8c94a0' : hot ? '#ff4a4a' : isWarm ? RED : COLD;
    if (live && val > MIN) {
        const ae = ang(Math.min(val, MAX));
        cv.arc(cx, cy, r - thick, r, A0, ae, col, { round: true });
        const a = ae * Math.PI / 180, rm = r - thick / 2;
        cv.circle(cx + Math.sin(a) * rm, cy - Math.cos(a) * rm, thick * 0.5 + 3, G.withAlpha('#ffffff', 0.22));
        cv.circle(cx + Math.sin(a) * rm, cy - Math.cos(a) * rm, thick * 0.5 + 1, '#ffffff');
    }
    cv.text(live ? Math.round(val) + '°' : '—', cx, cy + 10, 30,
        live ? (hot ? '#ff4a4a' : '#ffffff') : G.withAlpha('#8c94a0', 0.5),
        { align: 'center', font: 'num' });
    cv.text(label, cx, cy + r + 6, 15, '#ffffff',
        { align: 'center', font: 'bold', spacing: 1.4, literal: true });
}

/** The 20-minute temperature trend: three lines, legend with live readings, faint guides. */
function trendChart(cv, G, x, y, w, h, trend, temps) {
    // legend spread across the row: OIL left, COOL centre, GBX right
    const legend = [['OIL', RED, temps.oil], ['COOL', COLD, temps.coolant], ['GBX', '#b98cff', temps.gearbox]];
    legend.forEach((l, i) => {
        const v = l[2];
        const txt = l[0] + ' ' + (typeof v === 'number' && isFinite(v) ? Math.round(v) + '°' : '—');
        const tw = txt.length * 9;
        if (i === 0) {
            cv.circle(x + 6, y + 13, 5, l[1]);
            cv.text(txt, x + 17, y + 18, 14, '#ffffff', { font: 'bold', spacing: 0.8, literal: true });
        } else if (i === 1) {
            cv.circle(x + w / 2 - tw / 2 - 10, y + 13, 5, l[1]);
            cv.text(txt, x + w / 2 + 7, y + 18, 14, '#ffffff',
                { align: 'center', font: 'bold', spacing: 0.8, literal: true });
        } else {
            cv.circle(x + w - tw - 20, y + 13, 5, l[1]);
            cv.text(txt, x + w, y + 18, 14, '#ffffff',
                { align: 'right', font: 'bold', spacing: 0.8, literal: true });
        }
    });
    const cy = y + 30, ch = h - 40;
    cv.roundRect(x, cy, w, ch, 8, G.withAlpha('#ffffff', 0.035));
    const span = 20 * 60 * 1000;
    const now = trend.length ? trend[trend.length - 1][0] : 0;
    const MIN = 0, MAX = 150;
    const cols = [RED, COLD, '#b98cff'];
    [50, 100].forEach((g) => {
        const gy = cy + ch - (g / MAX) * ch;
        cv.line(x + 8, gy, x + w - 8, gy, 1, G.withAlpha('#ffffff', g === 100 ? 0.14 : 0.07));
    });
    [1, 2, 5].forEach((idx, li) => {
        let px = null, py = null, ex = null, ey = null;
        for (const p of trend) {
            const v = p[idx];
            if (typeof v !== 'number' || !isFinite(v)) { px = null; continue; }
            const tx = x + w - ((now - p[0]) / span) * w;
            const ty = cy + ch - Math.max(0, Math.min(1, (v - MIN) / (MAX - MIN))) * ch;
            if (px !== null) cv.line(px, py, tx, ty, 4, G.withAlpha(cols[li], 0.95));
            px = tx; py = ty; ex = tx; ey = ty;
        }
        if (ex !== null) cv.circle(ex, ey, 5.5, cols[li]);
    });
}

function draw(cv, G, t, s, actions) {
    const y0 = (G.TOP || 44) + 8, y1 = H - 8, h = y1 - y0;
    const xAt = (xTop, y) => xTop - (y - y0) / h * SLANT;
    const now = Date.now();

    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'RACE MODES', 'CAR DATA', 'WARMUP'], 4, [
        s.demo && { text: 'DEMO · NOT VEHICLE DATA', color: 'crit' },
    ]);
    G.sectionRule(cv, t, 24, G.TOP || 44, W - 48, t.stripes || RED);

    cv.fillRect(0, y0, W, h, t.bg);
    Sheet.drawHexMesh(cv, G, y0, y1, false);

    // slanted black stage slab
    const slabX = 294, slabW = 740, slabS = Math.round(SLANT * (h - 12) / h);
    Sheet.para(cv, slabX, y0 + 8, slabW, y1 - 4, slabS, '#000000');
    cv.line(slabX, y0 + 8, slabX + slabW, y0 + 8, 2, G.withAlpha('#f32635', 0.4));
    cv.line(slabX, y0 + 8, slabX - slabS, y1 - 4, 1.5, G.withAlpha('#f32635', 0.25));
    cv.line(slabX + slabW - slabS, y1 - 4, slabX + slabW, y0 + 8, 1.5, G.withAlpha('#f32635', 0.25));

    // title tag (top-level page: no back chip)
    const tagX = 40, tagY = y0 + 24, tagW = Sheet.titleTagWidth(cv, 'WARM UP', 23, 196, 1.4), tagH = 46, tagSlant = 15;
    Sheet.para(cv, tagX, tagY, tagW, tagY + tagH, tagSlant, G.withAlpha('#c8192b', 0.94));
    cv.text('WARM UP', tagX + (tagW - tagSlant) / 2, tagY + 34, 23, '#ffffff',
        { align: 'center', font: 'num', spacing: 1.4, literal: true });

    // ---- slab content
    const ix = slabX + 34, iw = slabW - 96 - slabS;
    const temps = s.temps || {}, warm = s.warm || {};

    // status: pulsing dot + spaced text + "n/3 READY", gradient underline
    const st = s.status || { text: '—', kind: 'dim' };
    const scol = st.kind === 'ready' ? GO : st.kind === 'cold' ? COLD
        : st.kind === 'crit' ? '#ff4a4a' : st.kind === 'dim' ? G.withAlpha('#8c94a0', 0.8) : AMBER;
    const pulse = 0.45 + 0.55 * Math.sin(now / (st.kind === 'ready' ? 420 : 700));
    cv.circle(ix + 8, y0 + 50, 10, G.withAlpha(scol, 0.10 + 0.18 * pulse));
    cv.circle(ix + 8, y0 + 50, 4.5, scol);
    cv.text(st.text, ix + 30, y0 + 60, 26, scol, { font: 'bold', spacing: 2.2, literal: true });
    const readyN = BAR_KEYS.reduce((n, b) =>
        n + ((temps[b.key] || 0) >= (warm[b.key] || 90) ? 1 : 0), 0);
    cv.text(readyN + ' / 3 READY', ix + iw, y0 + 58, 15, G.withAlpha('#e8c8ce', 0.5),
        { align: 'right', font: 'bold', spacing: 1.3, literal: true });
    cv.rampRect(ix, y0 + 76, iw, 2.5, 1, [G.withAlpha(scol, 0.65), G.withAlpha(scol, 0.04)]);

    // turbo cool-down countdown strip while the turbo needs a gentle minute
    const cd = s.cooldown || {};
    let gcy = y0 + 150;
    if (cd.active) {
        const cy2 = y0 + 92, ch2 = 48, left = Math.max(0, Math.ceil(cd.left));
        cv.roundRect(ix, cy2, iw, ch2, 8, G.withAlpha(AMBER, 0.08));
        cv.rampRect(ix, cy2, 5, ch2, 2, [AMBER, G.withAlpha(AMBER, 0.3)]);
        cv.text('TURBO TIMER', ix + 20, cy2 + 28, 13, G.withAlpha('#e8c8ce', 0.6),
            { font: 'bold', spacing: 1.3, literal: true });
        cv.text(cd.done ? 'DONE — OK TO SWITCH OFF' : 'KEEP IT GENTLE', ix + iw - 110, cy2 + 28, 13,
            cd.done ? GO : AMBER, { align: 'right', font: 'bold', spacing: 1, literal: true });
        cv.text(left + ' s', ix + iw - 20, cy2 + 31, 24, left > 0 ? '#ffffff' : GO,
            { align: 'right', font: 'num', literal: true });
        const f = cd.needS ? Math.max(0, Math.min(1, 1 - left / cd.needS)) : 1;
        cv.roundRect(ix + 20, cy2 + ch2 - 10, iw - 40, 5, 2.5, G.withAlpha('#ffffff', 0.09));
        if (f > 0) cv.rampRect(ix + 20, cy2 + ch2 - 10, Math.max(5, (iw - 40) * f), 5, 2.5,
            [AMBER, GO], ix + 20, iw - 40);
        gcy = y0 + 202;
    }

    const gaugeR = 58;
    const gxs = [ix + iw / 6, ix + iw / 2, ix + iw * 5 / 6];
    BAR_KEYS.forEach((b, i) => {
        tempGauge(cv, G, gxs[i], gcy, gaugeR, temps[b.key], warm[b.key] || 90, b.label);
    });

    const ty = gcy + gaugeR + 36;
    trendChart(cv, G, ix, ty, iw, Math.max(56, y1 - 28 - ty), s.trend || [], temps);

    // ---- right ribbon
    const ribX = 1128;
    Sheet.para(cv, ribX,       y0, 210, y1, SLANT, '#2a0b12');
    Sheet.para(cv, ribX + 210, y0, 112, y1, SLANT, '#1b070c');
    Sheet.para(cv, ribX + 322, y0, 62,  y1, SLANT, '#8c1122');
    Sheet.para(cv, ribX + 384, y0, 56,  y1, SLANT, '#d91c33');

    const rows = s.rows || [];
    for (let i = 0; i < 5; i++) {
        const row = rows[i] || { label: '—', value: null };
        const text = row.value === null || row.value === undefined ? '—' : String(row.value);
        const live = text !== '—' && text !== '';
        const ry = y0 + 34 + i * 84;
        const rx = xAt(ribX + 26, ry);
        cv.fillRect(rx + 12, ry - 2, 4, 66, G.withAlpha('#c8ced8', live ? 0.9 : 0.35));
        cv.fillRect(rx + 12, ry + 56, 4, 8, live ? '#f32635' : G.withAlpha('#c8ced8', 0.3));
        cv.text(row.label, rx + 44, ry + 21, 13, G.withAlpha('#e8c8ce', 0.55),
            { font: 'bold', spacing: 1.0, literal: true });
        const vcol = row.color || (live ? RED : G.withAlpha('#8c94a0', 0.5));
        cv.text(text, rx + 44, ry + 50, row.font || 25, vcol,
            { font: 'num', spacing: 0.5, literal: true });
        Sheet.drawBarSegs(cv, G, rx + 44, ry + 72, !!row.lit);
    }
}

module.exports = { W, H, draw };
