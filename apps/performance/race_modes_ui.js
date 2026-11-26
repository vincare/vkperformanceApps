'use strict';

const W = 1600, H = 520;

function card(cv, G, t, x, y, w, h, title, subtitle, kind, onOpen) {
    const art = require('./flap_ui').sectionArt(kind, t.bg);
    if (art) {
        // Every badge at the same on-screen height: the badge itself is the button.
        const ih = 230, iw = Math.round(ih * art.w / art.h);
        const ix = x + (w - iw) / 2, iy = y + (h - ih) / 2;
        cv.image(art.id, ix, iy, iw, ih);
        if (cv.own && onOpen) cv.target(ix, iy, iw, ih, onOpen, 'performance_race_' + kind, 26);
        return;
    }
    cv.roundRect(x, y, w, h, 9, G.withAlpha('#ffffff', 0.035));
    cv.strokeRoundRect(x, y, w, h, 9, 1.5, G.withAlpha('#ffffff', 0.18));
    cv.fillRect(x + 1, y + 24, 4, 68, t.accent);

    const cx = x + w / 2, iy = y + 46;
    cv.roundRect(cx - 58, iy, 116, 116, 7, G.withAlpha('#111317', 0.96));
    cv.strokeRoundRect(cx - 58, iy, 116, 116, 7, 2, G.withAlpha(t.accent, 0.68));
    cv.fillRect(cx - 39, iy + 17, 26, 3, t.accent);
    if (kind === 'dyno') {
        cv.line(cx - 30, iy + 86, cx - 30, iy + 38, 2, G.withAlpha('#c7cbd1', 0.7));
        cv.line(cx - 30, iy + 86, cx + 34, iy + 86, 2, G.withAlpha('#c7cbd1', 0.7));
        cv.polyline([[cx - 25, iy + 76], [cx - 8, iy + 64], [cx + 5, iy + 67], [cx + 18, iy + 43], [cx + 32, iy + 35]], 4, t.accent);
        cv.polyline([[cx - 25, iy + 82], [cx - 8, iy + 71], [cx + 5, iy + 68], [cx + 18, iy + 59], [cx + 32, iy + 52]], 2.5, t.accent2 || t.accent);
    } else {
        cv.fillRect(cx - 29, iy + 38, 58, 4, G.withAlpha('#c7cbd1', 0.75));
        cv.fillRect(cx - 29, iy + 55, 58, 4, G.withAlpha('#c7cbd1', 0.75));
        cv.fillRect(cx - 29, iy + 72, 58, 4, G.withAlpha('#c7cbd1', 0.75));
        [iy + 38, iy + 55, iy + 72].forEach((yy, i) => {
            cv.circle(cx - 36, yy + 2, 4, i === 2 ? t.accent : G.withAlpha('#c7cbd1', 0.72));
            cv.circle(cx + 36, yy + 2, 4, i === 0 ? t.accent : G.withAlpha('#c7cbd1', 0.72));
        });
    }

    cv.text(title, cx, y + 201, 27, '#ffffff', { align: 'center', font: 'bold', spacing: 1.5, literal: true });
    cv.text(subtitle, cx, y + 238, 14, t.dim, { align: 'center', font: 'label' });
    const bx = x + 34, by = y + h - 76, bw = w - 68, bh = 50;
    cv.roundRect(bx, by, bw, bh, 6, G.withAlpha(t.accent, 0.84));
    cv.strokeRoundRect(bx, by, bw, bh, 6, 1.5, G.withAlpha(t.accent, 0.95));
    cv.text('OPEN ' + title, cx, by + 32, 17, '#ffffff', { align: 'center', font: 'bold', spacing: 1.3, literal: true });
    if (cv.own && onOpen) cv.target(x, y, w, h, onOpen, 'performance_race_' + kind, 20);
}

function draw(cv, G, t, actions) {
    cv.clear(t.bg);
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'RACE MODES', 'CAR DATA', 'WARMUP'], 2,
        actions.modeBadge ? [{ text: actions.modeBadge, color: actions.modeColor }] : []);
    G.sectionRule(cv, t, 24, G.TOP || 44, W - 48, t.stripes || '#f32635');
    // Same card geometry and badge size as ENGINE CONFIG's section picker (flap_ui drawSectionMenu).
    const y = (G.TOP || 44) + 30, h = 414, w = 760, gap = 32;
    card(cv, G, t, 24, y, w, h, 'DYNO RUN', 'ROAD POWER & TORQUE ESTIMATE', 'dyno', actions && actions.dyno);
    card(cv, G, t, 24 + w + gap, y, w, h, 'DRAG RUN', 'ACCELERATION TIMES & RUN HISTORY', 'drag', actions && actions.drag);
    return cv;
}

module.exports = { W, H, draw };
