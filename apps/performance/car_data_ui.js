'use strict';
/**
 * car_data_ui.js - the CAR DATA tab: a menu of seven data sections, each opening a
 * live readout sheet in the same shell as DYNO RUN / DRAG RUN / EXHAUST SYSTEM
 * (hex mesh backdrop, slanted black stage slab, red title tag, right value ribbon).
 *
 * s.view: 'menu' | a SECTIONS key. s.rows: [{ label, value, detail }] ready to draw.
 */
const Sheet = require('./flap_ui');

const W = 1600, H = 520;
const RED = '#f32635';
const SLANT = Sheet.SLANT;

const SECTIONS = [
    { key: 'engineInfo', title: 'ENGINE INFO', sub: 'ENGINE VITALS & TEMPERATURES' },
    { key: 'powertrain', title: 'POWERTRAIN', sub: 'TORQUE · POWER · THROTTLE' },
    { key: 'boost', title: 'BOOST', sub: 'CHARGE PRESSURE & INTAKE AIR' },
    { key: 'fuel', title: 'FUEL SYSTEM', sub: 'TANK LEVEL · RANGE · FUEL PRESSURE' },
    { key: 'ignition', title: 'IGNITION', sub: 'SPARK TIMING & START SYSTEM' },
    { key: 'drivetrain', title: 'DRIVETRAIN', sub: 'GEARBOX · XDRIVE · ENGINE' },
    { key: 'electrical', title: 'ELECTRICAL', sub: 'BATTERY & VEHICLE SYSTEMS' },
    { key: 'tyres', title: 'TYRES INFO', sub: 'PRESSURE & TEMPERATURE PER WHEEL' },
];

function sectionOf(key) { return SECTIONS.find((s) => s.key === key) || SECTIONS[0]; }

function menuCard(cv, G, t, x, y, w, h, def, action) {
    // CAR DATA's eight badges are decoded a little at a time after the menu
    // appears. Drawing must never synchronously decode the whole image set.
    const art = Sheet.cachedSectionArt(def.key, t.bg);
    if (art) {
        // The supplied badge already carries the section's name; the badge itself is the button.
        const ih = 150, iw = Math.round(ih * art.w / art.h);
        const ix = x + (w - iw) / 2, iy = y + (h - ih) / 2;
        cv.image(art.id, ix, iy, iw, ih);
        if (cv.own && action) cv.target(ix, iy, iw, ih, action, 'performance_cardata_' + def.key, 30);
        return;
    }
    cv.roundRect(x, y, w, h, 9, G.withAlpha('#ffffff', 0.035));
    cv.strokeRoundRect(x, y, w, h, 9, 1.5, G.withAlpha('#ffffff', 0.18));
    cv.fillRect(x + 1, y + 20, 4, 52, t.accent);
    cv.text(def.title, x + w / 2, y + h / 2 - 6, 26, '#ffffff',
        { align: 'center', font: 'bold', spacing: 1.4, literal: true });
    cv.text(def.sub, x + w / 2, y + h / 2 + 26, 12, t.dim,
        { align: 'center', font: 'label' });
    if (cv.own && action) cv.target(x, y, w, h, action, 'performance_cardata_' + def.key, 20);
}

function drawMenu(cv, G, t, actions) {
    // Eight sections: 4 cards on each of two rows.
    const w = 370, h = 196, gap = 20, y1 = (G.TOP || 44) + 30, y2 = y1 + h + gap;
    const row = SECTIONS.slice(0, 4), row2 = SECTIONS.slice(4);
    row.forEach((def, i) => {
        menuCard(cv, G, t, 24 + i * (w + gap), y1, w, h, def, actions && actions[def.key]);
    });
    const x0 = row2.length >= 4 ? 24 : (W - (row2.length * w + (row2.length - 1) * gap)) / 2;
    row2.forEach((def, i) => {
        menuCard(cv, G, t, x0 + i * (w + gap), y2, w, h, def, actions && actions[def.key]);
    });
}

function drawSheet(cv, G, t, s, car, actions) {
    const def = sectionOf(s.view);
    const y0 = (G.TOP || 44) + 8, y1 = H - 8, h = y1 - y0;
    const xAt = (xTop, y) => xTop - (y - y0) / h * SLANT;

    // 1. Dark backdrop + subtle red hex lines across the whole background
    cv.fillRect(0, y0, W, h, t.bg);
    Sheet.drawHexMesh(cv, G, y0, y1, false);

    // 2. Slanted black stage slab — the section badge is the hero on it
    const slabX = 294, slabW = 740, slabS = Math.round(SLANT * (h - 12) / h);
    Sheet.para(cv, slabX, y0 + 8, slabW, y1 - 4, slabS, '#000000');
    cv.line(slabX, y0 + 8, slabX + slabW, y0 + 8, 2, G.withAlpha('#f32635', 0.4));
    cv.line(slabX, y0 + 8, slabX - slabS, y1 - 4, 1.5, G.withAlpha('#f32635', 0.25));
    cv.line(slabX + slabW - slabS, y1 - 4, slabX + slabW, y0 + 8, 1.5, G.withAlpha('#f32635', 0.25));

    const wheel = def.key === 'tyres' ? Sheet.sectionArt('tyreWheel', '#000000') : null;
    if (wheel) {
        // The car large in the slab's upper part; a row of four wheels along its bottom,
        // each with the corner code and live pressure above it.
        const codes = ['FL', 'FR', 'RL', 'RR'];
        const values = codes.map((code, i) => {
            const source = s.rows && s.rows[i] && s.rows[i].value;
            const match = source === null || source === undefined
                ? null : String(source).match(/(\d+(?:[.,]\d+)?)\s*bar\b/i);
            return { text: match ? match[1] + ' bar' : '—', live: !!match };
        });
        if (s.side) {
            // Keep all paired side-view artwork clear of the four tyre readouts.
            // Legacy art is wide; the newer G11/G12 and G30 artwork is 3:2.
            const maxW = Math.min(slabW - 160, 560), maxH = 210;
            const scale = Math.min(maxW / s.side.width, maxH / s.side.height);
            const cw = s.side.width * scale, ch = s.side.height * scale;
            const imageX = slabX + (slabW - cw) / 2 - slabS / 2;
            const imageY = y0 + 34 + (maxH - ch) / 2;
            cv.image(s.side.id, imageX, imageY, cw, ch);
        }
        const gap = 34;
        const ww = Math.min((slabW - 140 - 3 * gap) / 4, 88);
        const wh = ww * wheel.h / wheel.w;
        const startX = slabX + (slabW - (4 * ww + 3 * gap)) / 2 - slabS / 2;
        const wy = y1 - 14 - wh;
        codes.forEach((code, i) => {
            const wx = startX + i * (ww + gap), cxm = wx + ww / 2;
            cv.image(wheel.id, wx, wy, ww, wh);
            cv.text(code, cxm, wy - 62, 21, '#ffffff',
                { align: 'center', font: 'bold', spacing: 1.6, literal: true });
            cv.text(values[i].text, cxm, wy - 30, 20,
                values[i].live ? RED : G.withAlpha('#8c94a0', 0.6),
                { align: 'center', font: 'num', spacing: 0.4, literal: true });
        });
    } else {
        // Every section sheet: the car side view fills the slab — nothing below it.
        if (s.side) {
            const maxW = Math.min(slabW - 160, 640), maxH = y1 - y0 - 90;
            const scale = Math.min(maxW / s.side.width, maxH / s.side.height);
            const cw = s.side.width * scale, ch = s.side.height * scale;
            cv.image(s.side.id, slabX + (slabW - cw) / 2 - slabS / 2, y0 + (y1 - y0 - ch) / 2 + 12, cw, ch);
        }
    }


    // 3. Title tag + back chip (same as DYNO RUN)
    const tagX = 40, tagY = y0 + 24, tagW = 196, tagH = 46, tagSlant = 15;
    Sheet.para(cv, tagX, tagY, tagW, tagY + tagH, tagSlant, G.withAlpha('#c8192b', 0.94));
    cv.text(def.title, tagX + (tagW - tagSlant) / 2, tagY + 32, 20, '#ffffff',
        { align: 'center', font: 'num', spacing: 1.4, literal: true });
    Sheet.drawBackChip(cv, G, tagX, tagY, tagH, actions, 'performance_cardata_back');

    // 4. Smooth diagonal panel on the right (same ribbon as DYNO RUN)
    const ribX = 1128;
    Sheet.para(cv, ribX,       y0, 210, y1, SLANT, '#2a0b12');
    Sheet.para(cv, ribX + 210, y0, 112, y1, SLANT, '#1b070c');
    Sheet.para(cv, ribX + 322, y0, 62,  y1, SLANT, '#8c1122');
    Sheet.para(cv, ribX + 384, y0, 56,  y1, SLANT, '#d91c33');

    // 5. Five live values along the diagonal: accent tick, label, big value, bar segs
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
        cv.text(text, rx + 44, ry + 46, 25, live ? RED : G.withAlpha('#8c94a0', 0.5),
            { font: 'num', spacing: 0.5, literal: true });
        Sheet.drawBarSegs(cv, G, rx + 44, ry + 72, live);
    }
}

function draw(cv, G, t, s, actions) {
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'RACE MODES', 'CAR DATA', 'WARMUP'], 3, [
        s.demo && { text: 'DEMO · NOT VEHICLE DATA', color: 'crit' },
    ]);
    G.sectionRule(cv, t, 24, G.TOP || 44, W - 48, t.stripes || RED);
    if (s.view === 'menu') drawMenu(cv, G, t, actions);
    else drawSheet(cv, G, t, s, s.car, actions);
    return cv;
}

module.exports = { W, H, draw, SECTIONS, prepareArt: Sheet.sectionArt };
