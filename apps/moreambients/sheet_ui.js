'use strict';
/**
 * sheet_ui.js - the PERFORMANCE app's sheet chrome for MoreAmbients:
 * hex mesh backdrop, slanted black slab, diagonal red ribbon, red title tag,
 * chip buttons and the two-segment level bars. Same look, same constants.
 */

const W = 1600, H = 520;
const RED = '#f32635';
const GO = '#2fd27a';
const AMBER = '#ffb31a';
const SLANT = 152;

function para(cv, xTop, y0, w, y1, slant, c) {
    cv.quad([[xTop, y0], [xTop + w, y0], [xTop + w - slant, y1], [xTop - slant, y1]], c);
}

function drawHexMesh(cv, G, y0, y1) {
    const r = 104, dx = r * 1.5, dy = r * Math.sqrt(3);
    const c = G.withAlpha(RED, 0.13);
    if (cv.clip) cv.clip(0, y0, W, y1 - y0);
    for (let col = -1; col < 13; col++) {
        const cx = col * dx;
        for (let row = -1; row < 5; row++) {
            const cy = y0 + row * dy + (col & 1 ? dy / 2 : 0);
            for (let k = 0; k < 6; k++) {
                const a0 = k * Math.PI / 3, a1 = (k + 1) * Math.PI / 3;
                const p0 = [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r];
                const p1 = [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r];
                if ((p0[1] >= y0 - 20 && p0[1] <= y1 + 20) || (p1[1] >= y0 - 20 && p1[1] <= y1 + 20))
                    cv.line(p0[0], p0[1], p1[0], p1[1], 1.25, c);
            }
        }
    }
    if (cv.noclip) cv.noclip();
}

/** Two slanted level bars under a ribbon row; the second lights red when selected. */
function drawBarSegs(cv, G, x, y, selected) {
    const sw = 68, sh = 4.5, gap = 7, sl = 4;
    const c0 = selected ? '#9ca4b0' : G.withAlpha('#8c94a0', 0.55);
    const c1 = selected ? '#ff243b' : G.withAlpha('#8c94a0', 0.42);
    cv.quad([[x + sl, y], [x + sl + sw, y], [x + sw, y + sh], [x, y + sh]], c0);
    const x2 = x + sw + gap;
    cv.quad([[x2 + sl, y], [x2 + sl + sw, y], [x2 + sw, y + sh], [x2, y + sh]], c1);
}

/** Slanted chip button (BACK / DRAG HISTORY style). run+key add a joystick target. */
function drawChip(cv, G, x, y, w, label, opts) {
    const bkH = (opts && opts.h) || 36;
    para(cv, x, y, w, y + bkH, 12, (opts && opts.fill) || G.withAlpha('#ffffff', 0.08));
    if (opts && opts.icon === 'fwd') {
        cv.line(x + w - 24, y + 10, x + w - 16, y + bkH / 2, 2.4, '#ffffff');
        cv.line(x + w - 16, y + bkH / 2, x + w - 24, y + bkH - 10, 2.4, '#ffffff');
        cv.text(label, x + (w - 16) / 2, y + bkH / 2 + 6, (opts && opts.size) || 15, '#ffffff',
            { align: 'center', font: 'bold', spacing: 1.4, literal: true });
    } else {
        cv.line(x + 22, y + 10, x + 14, y + bkH / 2, 2.4, '#ffffff');
        cv.line(x + 14, y + bkH / 2, x + 22, y + bkH - 10, 2.4, '#ffffff');
        cv.text(label, x + w / 2 + 7, y + bkH / 2 + 6, (opts && opts.size) || 15, '#ffffff',
            { align: 'center', font: 'bold', spacing: 1.4, literal: true });
    }
    if (cv.own && opts && opts.run) cv.target(x - 6, y - 4, w + 12, bkH + 8, opts.run, opts.key, 10);
}

function drawBackChip(cv, G, tagX, tagY, tagH, actions, targetKey, dy) {
    drawChip(cv, G, tagX, tagY + tagH + 14 + (dy || 0), 118, 'BACK',
        { icon: 'back', run: actions && actions.back, key: targetKey });
}

/** The slanted black stage slab + red hairlines, returns inner geometry. */
function slab(cv, G, y0, y1) {
    const h = y1 - y0;
    const slabX = 294, slabW = 740, slabS = Math.round(SLANT * (h - 12) / h);
    para(cv, slabX, y0 + 8, slabW, y1 - 4, slabS, '#000000');
    cv.line(slabX, y0 + 8, slabX + slabW, y0 + 8, 2, G.withAlpha(RED, 0.4));
    cv.line(slabX, y0 + 8, slabX - slabS, y1 - 4, 1.5, G.withAlpha(RED, 0.25));
    cv.line(slabX + slabW - slabS, y1 - 4, slabX + slabW, y0 + 8, 1.5, G.withAlpha(RED, 0.25));
    return { x: slabX, w: slabW, s: slabS, ix: slabX + 34, iw: slabW - 96 - slabS };
}

/** The four-band diagonal ribbon on the right. Returns ribX and xAt(). */
function ribbon(cv, y0, y1) {
    const h = y1 - y0;
    const ribX = 1128;
    para(cv, ribX,       y0, 210, y1, SLANT, '#2a0b12');
    para(cv, ribX + 210, y0, 112, y1, SLANT, '#1b070c');
    para(cv, ribX + 322, y0, 62,  y1, SLANT, '#8c1122');
    para(cv, ribX + 384, y0, 56,  y1, SLANT, '#d91c33');
    const xAt = (xTop, y) => xTop - (y - y0) / h * SLANT;
    return { ribX, xAt };
}

/** A ribbon row: pale tick bar + label + value + two-seg bars. Optional tap target. */
function ribbonRow(cv, G, xAt, ribX, ry, row) {
    const rx = xAt(ribX + 26, ry);
    cv.fillRect(rx + 12, ry - 2, 4, 56, G.withAlpha('#c8ced8', row.lit ? 0.9 : 0.35));
    cv.fillRect(rx + 12, ry + 46, 4, 8, row.lit ? RED : G.withAlpha('#c8ced8', 0.3));
    cv.text(row.label, rx + 44, ry + 18, 12, G.withAlpha('#e8c8ce', 0.55),
        { font: 'bold', spacing: 1.0, literal: true });
    const vcol = row.color || (row.value != null && row.value !== '—' ? RED : G.withAlpha('#8c94a0', 0.5));
    cv.text(row.value == null ? '—' : String(row.value), rx + 44, ry + 42, row.font || 23, vcol,
        { font: 'num', spacing: 0.5, literal: true });
    drawBarSegs(cv, G, rx + 44, ry + 60, !!row.lit);
    if (cv.own && row.run) cv.target(rx - 18, ry - 12, 348, 78, row.run, row.key, 10);
    return rx;
}

/** Red slanted title tag, PERFORMANCE style. */
function titleTag(cv, G, x, y, w, h, text, size) {
    para(cv, x, y, w, y + h, 15, G.withAlpha('#c8192b', 0.94));
    cv.text(text, x + (w - 15) / 2, y + h - 14, size || 20, '#ffffff',
        { align: 'center', font: 'jersey75', spacing: 1.4, literal: true });
}

/** The sheet chrome: tabs, section rule, backdrop, hex mesh. Returns geometry. */
function chrome(cv, G, t, tabs, active, badges) {
    const y0 = (G.TOP || 44) + 8, y1 = H - 8;
    G.frame(cv, t, tabs, active, badges);
    G.sectionRule(cv, t, 24, G.TOP || 44, W - 48, t.stripes || RED);
    cv.fillRect(0, y0, W, y1 - y0, t.bg);
    drawHexMesh(cv, G, y0, y1);
    return { y0, y1, h: y1 - y0 };
}

/** iDrive 8 toggle pill: green track when ON (like the OEM Ambience screen), dark when OFF. */
function id7Toggle(cv, G, x, y, on, green) {
    const w = 52, h = 24, r = 12;
    cv.roundRect(x, y, w, h, r, on ? (green ? '#5ec234' : '#4a5a78') : '#222a3a');
    cv.strokeRoundRect(x, y, w, h, r, 1.8, on && green ? '#98e870' : '#a8b4c8');
    const kx = on ? x + w - r : x + r, ky = y + r;
    cv.circle(kx, ky, 8.5, '#e8eef8');
    cv.circle(kx, ky, 7, '#ffffff');
}

/** Selection bar: dark cherry red, brighter red after ~40%, fading into the card bg,
 * with a soft black drop-shadow bleeding out underneath. */
function id7Highlight(cv, G, x, y, w, h) {
    cv.rampRect(x, y, w, h, 0, ['#8e0f1e', '#8e0f1e', '#9a1424', '#a81c2c', '#c02838', '#84293a', '#4f2732', '#2e252c', '#1e2024'], x, w);
    cv.line(x, y + 0.5, x + w, y + 0.5, 1.4, G.withAlpha('#ffffff', 0.55));
    cv.line(x, y + h - 0.5, x + w, y + h - 0.5, 1.2, G.withAlpha('#c8b8c0', 0.45));
    // strong black shadow under the bar
    for (let i = 1; i <= 18; i++) {
        cv.line(x, y + h + i - 0.5, x + w, y + h + i - 0.5, 1, G.withAlpha('#000000', 0.62 * (1 - i / 18)));
    }
}
const id7HighlightRed = id7Highlight;

/** iDrive 8 glass card background: slate-blue base + diagonal sheen + left-edge warm glow. */
function id8CardBg(cv, G, x, y, w, h) {
    // base: near-black smoked glass
    cv.fillRect(x, y, w, h, G.withAlpha('#1e2024', 0.94));
    // subtle diagonal facet in the upper-right
    cv.quad([[x + w * 0.52, y], [x + w, y], [x + w, y + h * 0.42], [x + w * 0.72, y + h * 0.22]],
        G.withAlpha('#2e323b', 0.42));
    // soft neutral wash down the left edge
    cv.rampRect(x, y, Math.round(w * 0.32), h, 0,
        [G.withAlpha('#9aa0ac', 0.14), G.withAlpha('#9aa0ac', 0)], x, Math.round(w * 0.32));
}

/** Small framed swatch: the colour fills the box cleanly, with a light border and outer glow. */
function drawSwatch(cv, G, x, y, w, h, c, disabled) {
    cv.fillRect(x - 2, y - 2, w + 4, h + 4, G.withAlpha(c, 0.35));
    cv.fillRect(x, y, w, h, c);
    if (disabled) cv.fillRect(x, y, w, h, G.withAlpha('#05070B', 0.58));
    cv.strokeRoundRect(x, y, w, h, 1, 1.2, G.withAlpha('#e8f6ff', 0.85));
}

/**
 * BMW iDrive 8 "AMBIENCE" panel (matches the OEM screen photo): frosted slate-blue card,
 * AMBIENCE title overlapping the top, pinned "Ambient lighting" header with green pill and
 * warm coral accent line under it, inset white dividers, external scrollbar on the right.
 */
function drawInteriorLighting(cv, G, opts) {
    const px = 88, pw = 560;
    const baseRows = [62, 72, 72, 118, 118, 72, 72, 72, 72, 72, 72];
    const basePh = baseRows.reduce((a, b) => a + b, 0);
    const py = 40;
    const bottom = H + (opts.extra || 0) - 4;
    const avail = bottom - py;
    const sc = Math.max(avail / basePh, 1.10);
    const rows = baseRows.map((r) => Math.round(r * sc));
    const pinH = rows[0];
    const headH = 69;
    const contentH = rows.reduce((a, b) => a + b, 0);
    const maxScroll = Math.max(0, contentH - avail + headH);
    const scrollY = Math.max(0, Math.min(maxScroll, opts.scroll || 0));
    const ph = avail;
    const focus = opts.focus;
    const divX0 = px, divX1 = px + pw;   // full-width dividers
    const lineC = G.withAlpha('#cfd8ec', 0.42);
    const lx = px + 32, rx = px + pw - 28;
    const txtC = (i) => i === focus ? '#ffffff' : '#eef2fa';

    // Frosted iD8 glass card (full panel)
    id8CardBg(cv, G, px, py, pw, ph);
    // Header band at the top of the card, slightly darker than the card itself
    cv.fillRect(px, py, pw, headH, G.withAlpha('#262930', 0.92));
    cv.line(px, py, px + pw, py, 1.4, G.withAlpha('#cfd8ec', 0.55));
    cv.text('INTERIOR LIGHTING', lx - 14, py + headH / 2 + 11, 32, '#c81f33', { font: 'bold', spacing: 0.8, literal: true });
    cv.line(px, py + headH, px + pw, py + headH, 1, G.withAlpha('#9aa0ac', 0.14));
    const pin0 = py + headH;
    const rowTop = [pin0];
    for (let i = 1; i <= rows.length; i++) {
        rowTop[i] = pin0 + pinH + rows.slice(1, i).reduce((a, b) => a + b, 0) - scrollY;
    }

    // 0. Pinned row (Ambient lighting): drawn first, outside the scroll clip
    if (focus === 0) id7Highlight(cv, G, px, pin0, pw, pinH);
    const c0 = pin0 + pinH / 2 + 4;
    cv.text('Ambient lighting', lx, c0 + 8, 26, txtC(0), { font: 'bold', literal: true });
    id7Toggle(cv, G, rx - 52, c0 - 12, !!opts.enabled, true);
    cv.line(px, pin0 + pinH, px + pw, pin0 + pinH, 1.2, G.withAlpha('#ffffff', 0.55));

    // Scrolling rows (1..n) inside the single clip below the pinned header
    cv.clip(px, pin0 + pinH, pw, ph - headH - pinH);
    if (focus > 0) id7Highlight(cv, G, px, rowTop[focus], pw, rows[focus]);
    rowTop.slice(2).forEach((y) => {
        if (y > pin0 + pinH + 14 && y <= py + ph) cv.line(divX0, y, divX1, y, 1.2, lineC);
    });

    // 1. Color + swatch(es): a picked combo shows its two zone colours, a colour one box
    const c1 = rowTop[1] + rows[1] / 2;
    cv.text('Color', lx, c1 + 8, 25, txtC(1), { font: 'bold', literal: true });
    if (opts.featureLighting && opts.featureLighting.key === 'mColor') {
        drawSwatch(cv, G, rx - 94, c1 - 14, 28, 28, opts.featureLighting.dashboard);
        drawSwatch(cv, G, rx - 60, c1 - 14, 28, 28, opts.featureLighting.door);
        drawSwatch(cv, G, rx - 26, c1 - 14, 28, 28, opts.featureLighting.footwell);
    } else if (opts.featureLighting) {
        drawSwatch(cv, G, rx - 96, c1 - 18, 96, 36, opts.featureLighting.dashboard);
    } else if (opts.combo) {
        drawSwatch(cv, G, rx - 132, c1 - 18, 62, 36, opts.combo.c1);   // dash · left
        drawSwatch(cv, G, rx - 62, c1 - 18, 62, 36, opts.combo.c2);    // footwells · right
    } else {
        drawSwatch(cv, G, rx - 96, c1 - 18, 96, 36, opts.color || '#18d8ff');
    }

    // 2. Zones + the Zones.png cabin icon
    const c3 = rowTop[2] + rows[2] / 2;
    cv.text('Zones', lx, c3 + 8, 25, txtC(2), { font: 'bold', literal: true });
    if (opts.zonesImg) {
        const zi = opts.zonesImg, zwW = 96, zwH = 36, zbx = rx - zwW, zby = c3 - zwH / 2;
        cv.fillRect(zbx - 2, zby - 2, zwW + 4, zwH + 4, G.withAlpha('#5ac8ff', 0.25));
        cv.image(zi.id, zbx + 4, zby + 2, zwW - 8, zwH - 4);
        cv.strokeRoundRect(zbx, zby, zwW, zwH, 1, 1.2, G.withAlpha('#e8f6ff', 0.85));
    }

    // 4 & 5: Background light & Accent lighting — 11 slanted segments
    const segs = 11, segX0 = lx + 46, segX1 = rx - 42, gap = 4, sl = 6, sh = 15;
    const segW = (segX1 - segX0 - (segs - 1) * gap - sl) / segs;
    const drawSlider = (rowIdx, label, val) => {
        const rt = rowTop[rowIdx], by = rt + Math.round(rows[rowIdx] * 0.72);
        cv.text(label, lx, rt + Math.round(rows[rowIdx] * 0.36) + 6, 25, txtC(rowIdx), { font: 'bold', literal: true });
        cv.line(lx, by, lx + 20, by, 3.2, '#eef2fa');
        cv.line(rx - 20, by, rx, by, 3.2, '#eef2fa');
        cv.line(rx - 10, by - 10, rx - 10, by + 10, 3.2, '#eef2fa');
        const litN = Math.round(Math.max(0, Math.min(100, val || 0)) / 100 * segs);
        for (let i = 0; i < segs; i++) {
            const sx = segX0 + i * (segW + gap), sy = by - sh / 2;
            const c = i < litN ? '#f4f7ff' : G.withAlpha('#8a96b0', 0.38);
            cv.quad([[sx + sl, sy], [sx + sl + segW, sy], [sx + segW, sy + sh], [sx, sy + sh]], c);
        }
        return by;
    };
    const byBg = drawSlider(3, 'Background light', opts.bgBrightness != null ? opts.bgBrightness : opts.brightness);
    const byAc = drawSlider(4, 'Accent lighting', opts.brightness);

    // 5..9: plain toggle rows
    const plain = [
        ['Reduced for night driving', 'night', !!opts.night], ['Dynamic light', 'dynamic', !!opts.dynamic],
        ['M Color Mode', 'mColorMode', !!(opts.features && opts.features.mColor)],
        ['Comfort Mode', 'comfortMode', !!(opts.features && opts.features.comfort)],
        ['Sport Mode', 'sportMode', !!(opts.features && opts.features.sport)],
        ['Eco Mode', 'ecoMode', !!(opts.features && opts.features.eco)]];
    plain.forEach(([label], k) => {
        const i = 5 + k, cy = rowTop[i] + rows[i] / 2;
        cv.text(label, lx, cy + 8, 25, txtC(i), { font: 'bold', literal: true });
        const on = plain[k][2];
        id7Toggle(cv, G, rx - 52, cy - 12, on, i >= 7);
    });
    cv.noclip();

    // Subtle outer card border
    cv.line(px, py, px, py + ph, 1.4, G.withAlpha('#cfd8ec', 0.55));
    cv.line(px + pw, py, px + pw, py + ph, 1.2, G.withAlpha('#cfd8ec', 0.38));
    cv.line(px, py + ph, px + pw, py + ph, 1.4, G.withAlpha('#cfd8ec', 0.55));

    // External scrollbar just to the right of the card
    let sbar = null;
    if (maxScroll > 0) {
        const trackX = px + pw + 10, trackY = py + 2, trackH = ph - 4;
        const thumbH = Math.max(28, Math.round(trackH * Math.min(0.42, avail / contentH)));
        const thumbY = trackY + Math.round((trackH - thumbH) * (scrollY / maxScroll));
        cv.fillRect(trackX, trackY, 3, trackH, G.withAlpha('#ffffff', 0.16));
        cv.fillRect(trackX, thumbY, 3, thumbH, '#ffffff');
        sbar = { x: trackX, y: trackY, w: 3, h: trackH };
    }

    const vis = (r) => {
        const top = r.i === 0 ? pin0 : pin0 + pinH;
        const y = Math.max(top, r.y);
        return { x: r.x, y, w: r.w, h: Math.min(py + ph, r.y + r.h) - y, i: r.i, key: r.key };
    };
    const rowKeys = ['oemLight', 'panelColour', 'panelZones', null, null, 'oemNight', 'oemDynamic', 'mColorMode', 'comfortMode', 'sportMode', 'ecoMode'];
    return {
        rows: rows.map((h, i) => vis({ x: px, y: rowTop[i], w: pw, h, i, key: rowKeys[i] })).filter((r) => r.h > 0),
        // unclipped geometry of EVERY row: the controller must be able to land on rows that are
        // currently scrolled out of view, then intoView() scrolls them in
        targets: rows.map((h, i) => ({ x: px, y: rowTop[i], w: pw, h, i, key: rowKeys[i] })),
        bgMinus: vis({ x: lx - 8, y: byBg - 22, w: 44, h: 44, key: 'bgDown', i: 3 }),
        bgPlus:  vis({ x: rx - 32, y: byBg - 22, w: 44, h: 44, key: 'bgUp', i: 3 }),
        bgBar:   vis({ x: segX0, y: byBg - 20, w: segX1 - segX0, h: 40, key: 'oemBrightness', zone: 'background', i: 3 }),
        minus:   vis({ x: lx - 8, y: byAc - 22, w: 44, h: 44, key: 'accentDown', i: 4 }),
        plus:    vis({ x: rx - 32, y: byAc - 22, w: 44, h: 44, key: 'accentUp', i: 4 }),
        accentBar: vis({ x: segX0, y: byAc - 20, w: segX1 - segX0, h: 40, key: 'oemBrightness', zone: 'accent', i: 4 }),
        scroll: { y: pin0 + pinH, max: maxScroll, cur: scrollY, bar: sbar },
        box: { x: px, y: py, w: pw, h: ph },
        offsets: rows.map((h, i) => i ? rows.slice(1, i).reduce((a, b) => a + b, 0) : 0),
        rowHs: rows, pinH: pinH + headH,
    };
}

/**
 * Full sub-page replacing the AMBIENCE panel (Colour / Combos / Zones) in the same iD8
 * frosted-glass card style, with a back arrow next to the AMBIENCE title and external scrollbar.
 */
function drawDetailPanel(cv, G, opts) {
    const px = 88, pw = 560;
    const py = 40;
    const bottom = H + (opts.extra || 0) - 4;
    const avail = bottom - py;
    const headH = 69;
    const rowH = opts.rowH || 66;
    const hasHeaderSwatches = !!(opts.imageSwatches && opts.imageSwatches.length >= 2);
    const infoBand = !!(opts.image || opts.imageInfo || hasHeaderSwatches);
    const imgH = opts.image ? 150 : hasHeaderSwatches ? 110 : infoBand ? 150 : 0;
    const contentH = imgH + opts.items.length * rowH;
    const maxScroll = Math.max(0, contentH - avail + headH);
    const scrollY = Math.max(0, Math.min(maxScroll, opts.scroll || 0));
    const divX0 = px, divX1 = px + pw;   // full-width dividers
    const lineC = G.withAlpha('#cfd8ec', 0.42);
    const lx = px + 32, rx = px + pw - 28;
    const top0 = py + headH;

    id8CardBg(cv, G, px, py, pw, avail);
    cv.clip(px, top0, pw, avail - headH);
    const contentTop = top0 - scrollY;
    for (let i = 1; i <= opts.items.length; i++) {
        const y = contentTop + imgH + i * rowH;
        if (y >= top0 && y <= py + avail) cv.line(divX0, y, divX1, y, 1.2, lineC);
    }
    if (infoBand) {
        if (opts.image) {
            const im = opts.image, iw = opts.imageInfo ? 198 : 240, ih = Math.round(iw * im.h / im.w);
            const ix = opts.imageInfo ? px + 28 : px + (pw - iw) / 2, iy = contentTop + (imgH - ih) / 2;
            if (iy + ih > top0 && iy < py + avail) {
                cv.fillRect(ix - 2, iy - 2, iw + 4, ih + 4, G.withAlpha('#5ac8ff', 0.25));
                cv.image(im.id, ix + 4, iy + 2, iw - 8, ih - 4);
                cv.strokeRoundRect(ix, iy, iw, ih, 1, 1.2, G.withAlpha('#e8f6ff', 0.85));
            }
        }
        if (hasHeaderSwatches) {
            // Zones header: selected colours span the full section, with no labels.
            const pad = 2, gap = 4, swatchCount = opts.imageSwatches.length;
            const swX = px + pad, swY = contentTop + pad;
            const swW = Math.floor((pw - pad * 2 - gap * (swatchCount - 1)) / swatchCount), swH = imgH - pad * 2;
            opts.imageSwatches.forEach((colour, i) => drawSwatch(cv, G, swX + i * (swW + gap), swY, swW, swH, colour));
        } else if (opts.imageInfo) {
            const infoX = px + 256;
            cv.text('NEXT APPLY TARGET', infoX, contentTop + 48, 11, G.withAlpha('#d6ddea', 0.6),
                { font: 'bold', spacing: 1, literal: true });
            cv.text(opts.imageInfo.name, infoX, contentTop + 84, 20, '#ffffff', { font: 'bold', literal: true });
            cv.text('Choose a zone below to preview its colour', infoX, contentTop + 112, 10.5,
                G.withAlpha('#d6ddea', 0.55), { literal: true });
        }
        cv.line(divX0, contentTop + imgH, divX1, contentTop + imgH, 1.2, lineC);
    }
    const swatches = [];
    const addZoneSwatch = (x, y, w, h, row, zone) => {
        const x0 = Math.max(px, x), y0 = Math.max(top0, y);
        const x1 = Math.min(px + pw, x + w), y1 = Math.min(py + avail, y + h);
        if (x1 > x0 && y1 > y0) swatches.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, row, zone });
    };
    opts.items.forEach((it, i) => {
        const y = contentTop + imgH + i * rowH;
        if (y + rowH < top0 || y > py + avail) return;
        // One red bar only: it follows the controller focus; the selected item keeps a check mark.
        const foc = opts.focus >= 0 && i === opts.focus;
        const sel = i === opts.sel || (opts.selList && opts.selList.indexOf(i) >= 0);
        const lit = foc || (!(opts.focus >= 0) && sel);
        if (lit) id7Highlight(cv, G, px, y, pw, rowH);
        const cy = y + rowH / 2;
        if (it.desc) {
            cv.text(it.name, lx, cy - 3, 21, lit || sel ? '#ffffff' : '#eef2fa', { font: 'bold', literal: true });
            cv.text(it.desc, lx, cy + 22, 11, G.withAlpha('#d6ddea', 0.56), { literal: true });
        } else {
            cv.text(it.name, lx, cy + 8, 25, lit || sel ? '#ffffff' : '#eef2fa', { font: 'bold', literal: true });
        }
        if (it.toggle) {
            const sx = rx - 72, sy = cy - 17, on = !!it.enabled;
            cv.roundRect(sx, sy, 64, 34, 17, on ? '#35C85A' : '#59616D');
            cv.strokeRoundRect(sx, sy, 64, 34, 17, 1.2, G.withAlpha('#F2F6FC', 0.7));
            cv.circle(on ? sx + 46 : sx + 18, cy, 12, '#F7F9FC');
        } else if (it.nav) {
            cv.line(rx - 14, cy - 10, rx - 5, cy, 3, '#d8e0ec');
            cv.line(rx - 5, cy, rx - 14, cy + 10, 3, '#d8e0ec');
        } else if (it.c2) {
            const leftX = rx - 132, rightX = rx - 62, swY = cy - 18;
            drawSwatch(cv, G, leftX, swY, 62, 36, it.c1);   // dash · left
            drawSwatch(cv, G, rightX, swY, 62, 36, it.c2);  // footwells · right
            if (it.zone === 'all') {
                addZoneSwatch(leftX, swY, 62, 36, i, 'upper');
                addZoneSwatch(rightX, swY, 62, 36, i, 'lower');
            }
        } else if (it.c1) {
            const swX = rx - 96, swY = cy - 18;
            drawSwatch(cv, G, swX, swY, 96, 36, it.c1, it.disabled);
            if (!it.disabled && ['dashboard', 'doors', 'footwell'].indexOf(it.zone) >= 0)
                addZoneSwatch(swX, swY, 96, 36, i, it.zone);
        }
        if (sel && !lit) {
            const markX = it.nav ? rx - 34 : it.c2 ? rx - 160 : it.c1 ? rx - 124 : rx - 34;
            cv.line(markX, cy + 1, markX + 7, cy + 8, 3, '#ffffff');
            cv.line(markX + 7, cy + 8, markX + 18, cy - 9, 3, '#ffffff');
        }
    });
    cv.noclip();

    // Outer card border
    cv.line(px, py, px, py + avail, 1.4, G.withAlpha('#cfd8ec', 0.55));
    cv.line(px + pw, py, px + pw, py + avail, 1.2, G.withAlpha('#cfd8ec', 0.38));
    cv.line(px, py + avail, px + pw, py + avail, 1.4, G.withAlpha('#cfd8ec', 0.55));

    // Header band: darker strip at the top with INTERIOR LIGHTING inside it (same alignment as main panel)
    cv.fillRect(px, py, pw, headH, G.withAlpha('#262930', 0.92));
    cv.line(px, py, px + pw, py, 1.4, G.withAlpha('#cfd8ec', 0.55));
    const bcy = py + headH / 2;
    cv.text('INTERIOR LIGHTING', lx - 14, bcy + 11, 32, '#c81f33', { font: 'bold', spacing: 0.8, literal: true });
    cv.line(px, top0, px + pw, top0, 1, G.withAlpha('#9aa0ac', 0.14));
    const back = null;

    let sbar = null;
    if (maxScroll > 0) {
        const trackX = px + pw + 10, trackY = py + 2, trackH = avail - 4;
        const thumbH = Math.max(28, Math.round(trackH * Math.min(0.42, avail / contentH)));
        const thumbY = trackY + Math.round((trackH - thumbH) * (scrollY / maxScroll));
        cv.fillRect(trackX, trackY, 3, trackH, G.withAlpha('#ffffff', 0.16));
        cv.fillRect(trackX, thumbY, 3, thumbH, '#ffffff');
        sbar = { x: trackX, y: trackY, w: 3, h: trackH };
    }
    const rows = opts.items.map((it, i) => {
        const y = Math.max(top0, contentTop + imgH + i * rowH);
        return { x: px, y, w: pw, h: Math.min(py + avail, contentTop + imgH + (i + 1) * rowH) - y, i };
    }).filter((r) => r.h > 0);
    // unclipped: controller targets for every item, even the ones scrolled off-screen
    const targets = opts.items.map((it, i) => ({ x: px, y: contentTop + imgH + i * rowH, w: pw, h: rowH, i }));
    return { rows, targets, swatches, back, scroll: { y: top0, max: maxScroll, cur: scrollY, bar: sbar },
        offsets: opts.items.map((it, i) => imgH + i * rowH), rowHs: opts.items.map(() => rowH), avail: avail - headH };
}

module.exports = { W, H, RED, GO, AMBER, SLANT, para, drawHexMesh, drawBarSegs, drawChip,
    drawBackChip, slab, ribbon, ribbonRow, titleTag, chrome, drawInteriorLighting, drawDetailPanel };
