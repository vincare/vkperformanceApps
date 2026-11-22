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

function drawConfigCard(cv, G, t, x, y, w, h, title, subtitle, kind, action) {
    cv.roundRect(x, y, w, h, 9, G.withAlpha('#ffffff', 0.035));
    cv.strokeRoundRect(x, y, w, h, 9, 1.5, G.withAlpha('#ffffff', 0.18));
    cv.fillRect(x + 1, y + 24, 4, 64, t.accent);

    const ix = x + 38, iy = y + 112, is = 144, cx = ix + is / 2, cy = iy + is / 2;
    cv.roundRect(ix, iy, is, is, 8, G.withAlpha('#111317', 0.96));
    cv.strokeRoundRect(ix, iy, is, is, 8, 2, G.withAlpha(t.accent, 0.72));
    cv.fillRect(ix + 14, iy + 14, 28, 3, t.accent);

    if (kind === 'exhaust') {
        [cy - 17, cy + 17].forEach((pipeY) => {
            cv.roundRect(cx - 46, pipeY - 8, 76, 16, 8, G.withAlpha('#9ca4ae', 0.94));
            cv.roundRect(cx - 43, pipeY - 5, 68, 10, 5, G.withAlpha('#16181c', 1));
            cv.circle(cx + 30, pipeY, 12, G.withAlpha('#d4d9df', 0.98));
            cv.circle(cx + 30, pipeY, 7, G.withAlpha('#17191d', 1));
            cv.circle(cx + 30, pipeY, 2.5, G.withAlpha(t.accent, 0.92));
        });
    } else {
        cv.roundRect(cx - 48, cy + 12, 62, 22, 10, G.withAlpha('#9ca4ae', 0.94));
        cv.roundRect(cx - 44, cy + 16, 52, 14, 7, G.withAlpha('#16181c', 1));
        cv.polyline([[cx + 15, cy + 10], [cx + 35, cy - 10], [cx + 28, cy + 8],
            [cx + 48, cy + 13], [cx + 28, cy + 22], [cx + 35, cy + 40]], 4, t.accent);
        cv.line(cx - 17, cy - 18, cx - 17, cy - 34, 2.5, G.withAlpha('#c7cbd1', 0.82));
        cv.line(cx - 1, cy - 22, cx + 5, cy - 36, 2.5, G.withAlpha(t.accent, 0.9));
        cv.line(cx + 15, cy - 18, cx + 26, cy - 29, 2.5, G.withAlpha('#c7cbd1', 0.82));
    }

    const tx = x + 222;
    cv.text(title, tx, y + 153, 29, '#ffffff', { font: 'bold', spacing: 1.2, literal: true });
    cv.text(subtitle, tx, y + 188, 15, t.dim, { font: 'bold', spacing: 0.9, literal: true });
    drawActionButton(cv, G, t, tx, y + 267, w - 258, 54, 'OPEN ' + title, action,
        { key: 'performance_' + kind + '_section', color: t.accent, primary: kind === 'exhaust' });
}

function drawSectionMenu(cv, G, t, car, actions) {
    const y = (G.TOP || 44) + 30, h = 414, w = 760, gap = 32;
    drawConfigCard(cv, G, t, 24, y, w, h, 'EXHAUST SYSTEM', 'VALVE CONTROL · DRIVE MODES', 'exhaust', actions && actions.open);
    drawConfigCard(cv, G, t, 24 + w + gap, y, w, h, 'EXHAUST BURBLES', 'BM3 BURBLE ADJUSTMENT', 'burbles', actions && actions.burbles);
}

function drawBurbles(cv, G, t, valve, actions) {
    const y = (G.TOP || 44) + 28, bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);
    G.panel(cv, t, 24, y, W - 48, bottom - y, 'EXHAUST BURBLES · BM3');
    const tune = valve.tune || {};
    const active = tune.burblesEnabled === true;
    const current = active ? (typeof tune.burbles === 'number' ? tune.burbles.toFixed(1) : 'CUSTOM')
        : tune.burblesEnabled === false ? 'OFF' : 'UNKNOWN';
    const stateColor = active ? (t.accent2 || '#81c4ff') : current === 'OFF' ? t.text : (t.warn || '#d29922');
    cv.text('EXHAUST BURBLES', W / 2, y + 102, 17, t.dim, { align: 'center', font: 'bold', spacing: 2 });
    cv.text(current, W / 2, y + 190, 68, stateColor, { align: 'center', font: 'bold', spacing: 2.4 });
    cv.text('TARGET AGGRESSION', W / 2, y + 225, 13, t.dim, { align: 'center', font: 'bold', spacing: 1.8 });
    cv.text(Number(valve.burbleTarget || 0).toFixed(1), W / 2, y + 274, 32, t.text, { align: 'center', font: 'num' });

    let status;
    if (!valve.ready) status = 'WAITING FOR DIAGNOSTIC LINK';
    else if (!valve.armed) status = 'CONTROL DISARMED · NO CHANGE CAN BE SENT';
    else if (!valve.bm3Rom) status = 'BM3 ROM NOT IDENTIFIED · NO BURBLE CHANGE SENT';
    else if (valve.commandStatus && /BURBLES/.test(valve.commandStatus)) status = valve.commandStatus;
    else status = 'BM3 ROM ' + valve.bm3Rom + ' · CHANGES REQUIRE A MANUAL APPLY';
    cv.text(status, W / 2, y + 311, 13, valve.bm3Rom ? t.dim : (t.warn || '#d29922'),
        { align: 'center', font: 'bold', spacing: 0.5, literal: true });
    if (!valve.bm3Rom && valve.bm3Error) {
        const err = String(valve.bm3Error).slice(0, 72).toUpperCase();
        cv.text(err, W / 2, y + 338, 11, t.dim, { align: 'center', font: 'label', literal: true });
    }

    const labels = [
        ['−', actions && actions.down], ['+', actions && actions.up],
        ['APPLY VALUE', actions && actions.apply], ['BURBLES OFF', actions && actions.off], ['BACK', actions && actions.back],
    ];
    const bw = 184, gap = 14, bh = 58, total = labels.length * bw + (labels.length - 1) * gap;
    let bx = (W - total) / 2;
    labels.forEach(([label, run], i) => {
        drawActionButton(cv, G, t, bx, bottom - bh - 14, bw, bh, label, run,
            { key: 'performance_burbles_' + i, primary: i === 2 });
        bx += bw + gap;
    });
}

function drawSidebar(cv, G, t, valve, car, actions, now) {
    const x = 24, y = (G.TOP || 44) + 28, w = 320, h = (G.BOTTOM || 512) - y;
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
    let buttonY = y + 82;
    modes.forEach(([key, label, run]) => {
        const selected = !!valve.selected && key === valve.selected;
        const busy = valve.busy && key !== 'OEM';
        const opts = { key: 'performance_flap_' + key, busy };
        if (selected) Object.assign(opts, { color: t.crit || RED, primary: true });
        drawActionButton(cv, G, t, x + 18, buttonY, w - 36, 78, label, run, opts);
        buttonY += 90;
    });

    // The centered page title occupies its own row above the car. Image bounds
    // start below it, keeping the car level with both sidebar cards.
    cv.text('BMW EXHAUST SYSTEM', 800, y + 72, 46, '#ffffff',
        { align: 'center', font: 'bold', spacing: 1.5, literal: true });
    drawCar(cv, G, t, valve, car, { x: 354, y: y + 84, w: 892, h: (G.BOTTOM || 512) - y - 96 }, now, true);
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
    const x = 1256, y = (G.TOP || 44) + 28, w = 320, h = (G.BOTTOM || 512) - y;
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
    const feedback = valve.commandStatus || 'READY FOR COMMAND';
    const feedbackColor = /DISARMED|UNAVAILABLE|REJECTED|BLOCKED|WAITING/.test(feedback)
        ? (t.crit || RED) : (valve.busy ? t.accent2 : t.dim);
    cv.text(feedback, x + 24, y + 302, 12, feedbackColor,
        { font: 'bold', spacing: 0.35, literal: true });
    if (label === 'DRIVE') {
        cv.text('DRIVING MODE', x + 24, y + 344, 12, t.dim, { font: 'bold', spacing: 1.8 });
        const driveMode = valve.drivingMode || (valve.driveModeLoading ? 'READING VEHICLE MODE' : 'UNAVAILABLE');
        cv.text(driveMode.toUpperCase(), x + 24, y + 380,
            driveMode.length > 15 ? 17 : 22, driveMode === 'UNAVAILABLE' ? t.dim : t.text,
            { font: 'bold', spacing: 1.8 });
    }
    cv.text('PHYSICAL VALVE POSITION NOT SENSED', x + 24, y + 438, 10, t.dim,
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
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'RACE MODES'], 1, [
        v.demo && { text: 'DEMO · NOT VEHICLE DATA', color: 'crit' },
    ]);
    G.sectionRule(cv, t, 24, G.TOP || 44, W - 48, t.stripes || RED);
    if (view === 'sections') drawSectionMenu(cv, G, t, car, sectionActions);
    else if (view === 'burbles') drawBurbles(cv, G, t, v, act);
    else {
        drawSidebar(cv, G, t, v, car, act, now);
        drawStatus(cv, G, t, v);
    }
    return cv;
}

module.exports = { W, H, draw, drawCar, drawSectionMenu, drawBurbles, drawSidebar, drawSmoke, drawValveFlaps, contain };
