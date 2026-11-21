'use strict';

const W = 1600, H = 520;
const RED = '#f32635';
let bladeProgress = null;
let bladeUpdatedAt = 0;

function drawSmoke(cv, G, t, car, imageRect, now, valveMode) {
    if (!car || !car.exhaustTips || car.exhaustTips.length !== 4) return;
    const seconds = (now || Date.now()) / 1000;
    const open = valveMode === 'OPEN' || valveMode == null;
    const activeTips = open ? 4 : 2;
    const grey = '#c8cdd4';
    car.exhaustTips.forEach((tip, tipIndex) => {
        if (tipIndex >= activeTips) return;
        const originX = imageRect.x + tip[0] * imageRect.w;
        const originY = imageRect.y + tip[1] * imageRect.h;
        const outward = tipIndex < 2 ? -1 : 1;
        // Five staggered, soft wisps per active tip. Anchors stay tied to the
        // measured source-PNG exhaust positions through contain scaling.
        for (let puff = 0; puff < 5; puff++) {
            const phase = (seconds * 0.3 + puff / 5 + tipIndex * 0.047) % 1;
            const driftX = outward * (2 + phase * Math.min(30, imageRect.w * 0.065));
            const driftY = 2 + phase * Math.min(42, imageRect.h * 0.12);
            const sway = Math.sin(seconds * 1.9 + puff * 1.7 + tipIndex) * 2.8;
            const x = originX + driftX + sway;
            const y = originY + driftY;
            const radius = 3 + phase * Math.min(21, imageRect.h * 0.062);
            const fade = 1 - phase;
            cv.circle(x, y, radius, G.withAlpha(grey, 0.15 * fade));
            cv.circle(x, y, radius * 0.68, G.withAlpha(grey, 0.28 * fade));
            cv.circle(x, y, radius * 0.34, G.withAlpha('#e0e3e7', 0.26 * fade));
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
    drawSmoke(cv, G, t, car, imageRect, now, valveMode);
    drawValveFlaps(cv, G, t, car, imageRect, valveMode, now);
}

function drawSectionMenu(cv, G, t, car, onOpen) {
    // Keep the section picker deliberately compact: a single exhaust icon and
    // the named button make it clear that no car graphic is drawn on this page.
    const x = 54, y = (G.TOP || 44) + 34, w = 320, h = 310;
    cv.roundRect(x, y, w, h, 8, G.withAlpha('#ffffff', 0.035));
    cv.strokeRoundRect(x, y, w, h, 8, 1.5, G.withAlpha('#ffffff', 0.18));
    cv.fillRect(x + 1, y + 26, 4, 62, t.accent);

    const ix = x + (w - 126) / 2, iy = y + 40, is = 126;
    cv.roundRect(ix, iy, is, is, 6, G.withAlpha('#111317', 0.96));
    cv.strokeRoundRect(ix, iy, is, is, 6, 2, G.withAlpha(t.accent, 0.72));
    cv.fillRect(ix + 14, iy + 16, 28, 3, t.accent);
    // Two parallel metal outlets with dark bores and subtle hot-gas strokes.
    // This uses only the MGU canvas primitives and remains crisp at any scale.
    [iy + 57, iy + 80].forEach((cy) => {
        cv.roundRect(ix + 25, cy - 7, 68, 14, 7, G.withAlpha('#9ca4ae', 0.92));
        cv.roundRect(ix + 27, cy - 4, 63, 8, 4, G.withAlpha('#16181c', 1));
        cv.circle(ix + 91, cy, 11, G.withAlpha('#d4d9df', 0.98));
        cv.circle(ix + 91, cy, 7, G.withAlpha('#17191d', 1));
        cv.circle(ix + 91, cy, 2.5, G.withAlpha(t.accent, 0.9));
    });
    cv.line(ix + 47, iy + 38, ix + 43, iy + 30, 2, G.withAlpha('#c7cbd1', 0.62));
    cv.line(ix + 65, iy + 36, ix + 65, iy + 27, 2, G.withAlpha(t.accent, 0.78));
    cv.line(ix + 83, iy + 38, ix + 88, iy + 30, 2, G.withAlpha('#c7cbd1', 0.62));

    drawActionButton(cv, G, t, x + 42, y + 208, w - 84, 66,
        'EXHAUST SYSTEM', onOpen, { key: 'performance_exhaust_section', color: t.accent, primary: true });
}

function drawSidebar(cv, G, t, valve, car, actions, now) {
    const x = 24, y = G.TOP || 44, w = 320, h = (G.BOTTOM || 512) - y;
    drawPanelShell(cv, G, t, x, y, w, h);
    cv.fillRect(x + 1, y + 27, 4, 54, t.accent);
    cv.text('SELECT MODE', x + 20, y + 57, 28, '#ffffff',
        { font: 'bold', spacing: 0.8, literal: true });

    const modes = [
        ['OPEN', 'OPEN VALVES', actions.open],
        ['CLOSED', 'CLOSE VALVES', actions.close],
        ['OEM', 'OEM CONTROL', actions.oem],
        ['DRIVE', 'BY DRIVE MODE', actions.drive],
    ];
    const controlEnabled = valve.ready && valve.armed && valve.matched && !valve.blocked;
    let buttonY = y + 82;
    modes.forEach(([key, label, run]) => {
        const selected = !!valve.selected && key === valve.selected;
        const disabled = !controlEnabled || valve.busy && key !== 'OEM';
        const opts = { key: 'performance_flap_' + key, busy: disabled };
        if (selected) Object.assign(opts, { color: t.crit || RED, primary: true });
        drawActionButton(cv, G, t, x + 18, buttonY, w - 36, 78, label,
            disabled ? null : run, opts);
        buttonY += 90;
    });

    // The centered page title occupies its own row above the car. Image bounds
    // start below it, keeping the car level with both sidebar cards.
    cv.text('BMW EXHAUST SYSTEM', 800, 116, 46, '#ffffff',
        { align: 'center', font: 'bold', spacing: 1.5, literal: true });
    drawCar(cv, G, t, valve, car, { x: 354, y: 128, w: 892, h: 372 }, now, true);
}

function drawValveFlaps(cv, G, t, car, imageRect, valveMode, now) {
    if (!car || !car.exhaustTips || car.exhaustTips.length !== 4) return;
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

function drawStatus(cv, G, t, valve) {
    const x = 1256, y = G.TOP || 44, w = 320, h = (G.BOTTOM || 512) - y;
    drawPanelShell(cv, G, t, x, y, w, h);
    cv.fillRect(x + 1, y + 27, 4, 54, t.accent);
    cv.text('EXHAUST MODE', x + 20, y + 57, 28, t.text,
        { font: 'bold', spacing: 0.8 });
    const label = valve.modeLabel || 'OEM';
    const lines = label === 'OPEN' ? ['OPENED', 'VALVES']
        : label === 'CLOSED' ? ['CLOSED', 'VALVES']
            : label === 'DRIVE' ? ['BY DRIVE', 'MODE'] : ['OEM', 'VALVES'];
    const color = label === 'OPEN' ? t.accent2 : label === 'CLOSED' ? t.crit : t.text;
    cv.text('CURRENT MODE', x + 24, y + 127, 13, t.dim, { font: 'bold', spacing: 1.8 });
    cv.text(lines[0], x + 24, y + 200, label === 'DRIVE' ? 29 : 36, color,
        { font: 'bold', spacing: 1.8 });
    cv.text(lines[1], x + 24, y + 244, 29, color,
        { font: 'bold', spacing: 1.8 });
    cv.fillRect(x + 24, y + 266, w - 48, 2, G.withAlpha(t.accent, 0.72));
    if (label === 'DRIVE') {
        cv.text('DRIVING MODE', x + 24, y + 316, 12, t.dim, { font: 'bold', spacing: 1.8 });
        const driveMode = valve.drivingMode || (valve.driveModeLoading ? 'READING VEHICLE MODE' : 'UNAVAILABLE');
        cv.text(driveMode.toUpperCase(), x + 24, y + 360,
            driveMode.length > 15 ? 17 : 22, driveMode === 'UNAVAILABLE' ? t.dim : t.text,
            { font: 'bold', spacing: 1.8 });
    }
    cv.text('PHYSICAL VALVE POSITION NOT SENSED', x + 24, y + 410, 10, t.dim,
        { font: 'bold', spacing: 0.2 });
}

function drawPanelShell(cv, G, t, x, y, w, h) {
    cv.roundRect(x, y, w, h, 7, G.withAlpha('#090a0c', 0.88));
    cv.strokeRoundRect(x, y, w, h, 7, 1.5, G.withAlpha('#ffffff', 0.14));
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
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG'], v.page || 0, [
        v.demo && { text: 'DEMO · NOT VEHICLE DATA', color: 'crit' },
    ]);
    if (view !== 'exhaust') drawSectionMenu(cv, G, t, car, sectionActions && sectionActions.open);
    else {
        drawSidebar(cv, G, t, v, car, act, now);
        drawStatus(cv, G, t, v);
    }
    return cv;
}

module.exports = { W, H, draw, drawCar, drawSectionMenu, drawSidebar, drawSmoke, drawValveFlaps, contain };
