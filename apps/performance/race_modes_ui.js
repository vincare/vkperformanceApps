'use strict';

const W = 1600, H = 520;

function card(cv, G, t, x, y, w, h, title, subtitle, kind, onOpen) {
    cv.roundRect(x, y, w, h, 9, G.withAlpha('#ffffff', 0.035));
    cv.strokeRoundRect(x, y, w, h, 9, 1.5, G.withAlpha('#ffffff', 0.18));
    cv.fillRect(x + 1, y + 24, 4, 68, t.accent);

    const cx = x + w / 2;
    cv.text(title, cx, y + 150, 30, '#ffffff', { align: 'center', font: 'bold', spacing: 1.5, literal: true });
    cv.fillRect(cx - 44, y + 168, 88, 4, t.accent);
    cv.text(subtitle, cx, y + 200, 14, t.dim, { align: 'center', font: 'label' });
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
