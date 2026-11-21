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
    const x = 54, y = 92, w = 1492, h = 390;
    cv.roundRect(x, y, 610, h, 12, G.withAlpha('#ffffff', 0.025));
    cv.strokeRoundRect(x, y, w, h, 12, 1.5, G.withAlpha('#ffffff', 0.16));
    cv.fillRect(x + 1, y + 26, 4, 74, t.accent);
    cv.text('ENGINE CONFIG', x + 38, y + 56, 15, t.dim,
        { font: 'bold', spacing: 2.4 });
    cv.text('VEHICLE SYSTEMS', x + 38, y + 91, 13, t.accent,
        { font: 'bold', spacing: 2 });
    cv.text('EXHAUST SYSTEM', x + 38, y + 166, 43, t.text,
        { font: 'bold', spacing: 2.5 });
    cv.text('BMW EXHAUST FLAP CONTROL', x + 40, y + 198, 16, t.dim,
        { font: 'bold', spacing: 1.7 });
    cv.text('Select a system to view its controls and status.', x + 40, y + 239, 16, t.dim,
        { font: 'label' });
    cv.roundRect(x + 38, y + 285, 250, 54, 27, G.withAlpha(t.accent, 0.92));
    cv.text('OPEN SECTION', x + 163, y + 319, 17, '#ffffff',
        { align: 'center', font: 'bold', spacing: 1.8 });
    cv.fillRect(x + 38, y + h - 20, 264, 2, G.withAlpha(t.accent, 0.9));

    // The image is composited against the page background, so its transparent
    // pixels do not leave a grey rectangle behind the car.
    drawCar(cv, G, t, null, car, { x: x + 650, y: y + 12, w: 810, h: h - 24 }, 0, false);
    if (cv.own && onOpen) cv.target(x, y, w, h, onOpen, 'performance_exhaust_section');
}

function drawSidebar(cv, G, t, valve, car, actions, now) {
    const x = 24, y = 72, w = 278, h = 414;
    cv.roundRect(x, y, w, h, 8, G.withAlpha('#090a0c', 0.88));
    cv.strokeRoundRect(x, y, w, h, 8, 1.5, G.withAlpha('#ffffff', 0.14));
    cv.fillRect(x + 1, y + 24, 4, 62, t.accent);
    cv.text('BMW', x + 24, y + 51, 12, t.dim, { font: 'bold', spacing: 2.5 });
    cv.text('EXHAUST', x + 24, y + 81, 23, t.text, { font: 'bold', spacing: 1.8 });
    cv.text('SYSTEM', x + 24, y + 108, 23, t.text, { font: 'bold', spacing: 1.8 });
    cv.text('FLAP CONTROL', x + 24, y + 132, 11, t.accent, { font: 'bold', spacing: 1.6 });

    const modes = [
        ['OPEN', 'OPEN VALVES', actions.open],
        ['CLOSED', 'CLOSE VALVES', actions.close],
        ['OEM', 'OEM CONTROL', actions.oem],
        ['DRIVE', 'BY DRIVE MODE', actions.drive],
    ];
    const controlEnabled = valve.ready && valve.armed && valve.matched && !valve.blocked;
    let buttonY = y + 145;
    modes.forEach(([key, label, run]) => {
        const selected = !!valve.selected && key === valve.selected;
        const disabled = !controlEnabled || valve.busy && key !== 'OEM';
        const opts = { key: 'performance_flap_' + key, busy: disabled };
        if (selected) Object.assign(opts, { color: t.crit || RED, primary: true });
        drawActionButton(cv, G, t, x + 16, buttonY, w - 32, 44, label,
            disabled ? null : run, opts);
        buttonY += 49;
    });

    cv.fillRect(x + 18, y + h - 66, w - 36, 1, G.withAlpha('#ffffff', 0.14));
    cv.roundRect(x + 16, y + h - 54, w - 32, 40, 20, G.withAlpha('#ffffff', 0.04));
    cv.strokeRoundRect(x + 16, y + h - 54, w - 32, 40, 20, 1.2, G.withAlpha('#ffffff', 0.2));
    cv.text('ALL SYSTEMS', x + w / 2, y + h - 28, 13, t.dim,
        { align: 'center', font: 'bold', spacing: 1.4 });
    if (cv.own && actions.back) cv.target(x + 16, y + h - 54, w - 32, 40,
        actions.back, 'performance_config_back');

    drawCar(cv, G, t, valve, car, { x: 310, y: 90, w: 856, h: 376 }, now, true);
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
    const x = 1184, y = 82, w = 392, h = 384;
    G.panel(cv, t, x, y, w, h, 'VALVE MODE');
    const label = valve.modeLabel || 'OEM';
    const lines = label === 'OPEN' ? ['OPENED', 'VALVES']
        : label === 'CLOSED' ? ['CLOSED', 'VALVES']
            : label === 'DRIVE' ? ['BY DRIVE', 'MODE'] : ['OEM', 'VALVES'];
    const color = label === 'OPEN' ? t.accent2 : label === 'CLOSED' ? t.crit : t.text;
    cv.text('CURRENT REQUEST', x + 28, y + 108, 12, t.dim, { font: 'bold', spacing: 1.8 });
    cv.text(lines[0], x + 28, y + 173, label === 'DRIVE' ? 31 : 38, color,
        { font: 'bold', spacing: 2.4 });
    cv.text(lines[1], x + 28, y + 214, 30, color,
        { font: 'bold', spacing: 2.3 });
    cv.fillRect(x + 28, y + 236, w - 56, 2, G.withAlpha(t.accent, 0.72));
    cv.text('DRIVING MODE', x + 28, y + 276, 12, t.dim, { font: 'bold', spacing: 1.8 });
    const driveMode = valve.drivingMode || 'UNAVAILABLE';
    cv.text(driveMode.toUpperCase(), x + 28, y + 319,
        driveMode.length > 15 ? 20 : 25, driveMode === 'UNAVAILABLE' ? t.dim : t.text,
        { font: 'bold', spacing: 1.8 });
    cv.text('PHYSICAL VALVE POSITION NOT SENSED', x + 28, y + 354, 12, t.dim,
        { font: 'bold', spacing: 0.4 });
}

function drawActionButton(cv, G, t, x, y, w, h, label, run, opts) {
    if (cv.own) return G.button(cv, t, x, y, w, h, label, run, opts);
    // Offline/software preview: show the page's controls even though the preview
    // head unit has no input owner and cannot register touch targets.
    const color = opts && opts.color || t.accent;
    const primary = !!(opts && opts.primary);
    cv.roundRect(x, y, w, h, h / 2, primary ? G.withAlpha(color, 0.28) : G.withAlpha('#ffffff', 0.07));
    cv.strokeRoundRect(x, y, w, h, h / 2, 1.5, G.withAlpha(color, primary ? 0.75 : 0.3));
    cv.text(String(label).toUpperCase(), x + w / 2, y + h / 2 + h * 0.15, h * 0.4,
        t.text, { align: 'center', font: 'bold', spacing: 1.5 });
}

function draw(cv, G, t, v, act, car, now, view, sectionActions) {
    cv.clear(t.bg);
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG'], v.page || 0, [
        v.demo && { text: 'DEMO · NOT VEHICLE DATA', color: 'crit' },
    ]);
    if (view !== 'exhaust') drawSectionMenu(cv, G, t, car, sectionActions && sectionActions.open);
    else {
        drawSidebar(cv, G, t, v, car, Object.assign({}, act, {
            back: sectionActions && sectionActions.back,
        }), now);
        drawStatus(cv, G, t, v);
    }
    return cv;
}

module.exports = { W, H, draw, drawCar, drawSectionMenu, drawSidebar, drawSmoke, drawValveFlaps, contain };
