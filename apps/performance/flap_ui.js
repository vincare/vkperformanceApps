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

function drawRear(cv, G, t, valve, car, now) {
    const x = 274, y = 70, w = 746, h = 406;
    G.panel(cv, t, x, y, w, h, 'BMW EXHAUST SYSTEM');
    cv.text('VALVE GRAPHIC + SMOKE · VISUAL ONLY', x + w - 16, y + 42, 11, t.dim,
        { align: 'right', font: 'bold', spacing: 0.8 });
    const bounds = { x: x + 12, y: y + 56, w: w - 24, h: h - 66 };
    if (!car || !car.imageId || !(car.width > 0) || !(car.height > 0)) {
        cv.text('CAR IMAGE UNAVAILABLE', x + w / 2, y + h / 2 + 8, 20, t.dim,
            { align: 'center', font: 'bold', spacing: 1 });
        return;
    }
    // object-fit: contain equivalent: preserve the supplied PNG's full 3:2 frame.
    const imageRect = contain(bounds, car.width, car.height);
    cv.image(car.imageId, imageRect.x, imageRect.y, imageRect.w, imageRect.h);
    const valveMode = valve && valve.exhaustMode || 'OEM';
    drawSmoke(cv, G, t, car, imageRect, now, valveMode);
    drawValveFlaps(cv, G, t, car, imageRect, valveMode, now);
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
    const x = 1038, y = 70, w = 538, h = 406;
    G.panel(cv, t, x, y, w, h, 'EXHAUST VALVE CONTROL');
    const realMatch = valve && valve.armed && valve.matched;
    const accent = realMatch ? t.accent2 : t.warn || '#d29922';
    cv.text(valve && valve.status ? valve.status : 'CHECKING CONTROL', x + 28, y + 96, 17, accent,
        { font: 'bold', spacing: 1.2 });

    const value = valve && valve.simulated ? 'DISARMED'
        : valve && valve.visualState && valve.visualState !== 'UNKNOWN' ? valve.visualState : 'UNKNOWN';
    const valueColor = value === 'OPEN' ? t.accent2 : value === 'CLOSED' ? t.crit : t.dim;
    cv.text(value, x + 28, y + 170, 55, valueColor, { font: 'bold', spacing: 2 });
    cv.text(valve && valve.simulated ? 'NO CAR COMMAND' : 'DME TARGET · POSITION UNVERIFIED',
        x + 32, y + 195, 14, t.dim, { font: 'bold', spacing: 1.2 });

    const lines = valve && valve.lines || [];
    lines.slice(0, 3).forEach((line, i) => {
        cv.text(line, x + 28, y + 229 + i * 24, 16, i === 0 ? t.text : t.dim, { font: i === 0 ? 'bold' : 'label' });
    });
    cv.text("DME command feedback does not verify the valve's physical position.", x + 28, y + 300, 13, t.dim,
        { font: 'label' });
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

function draw(cv, G, t, v, act, car, now) {
    cv.clear(t.bg);
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG'], v.page || 0, [
        v.demo && { text: 'DEMO · NOT VEHICLE DATA', color: 'crit' },
    ]);
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    drawRear(cv, G, t, v, car, now);
    drawStatus(cv, G, t, v);

    const modes = [
        ['OPEN', 'OPEN VALVES', act.open],
        ['CLOSED', 'CLOSE VALVES', act.close],
        ['OEM', 'OEM CONTROL', act.oem],
        ['DRIVE', 'BY DRIVE MODE', act.drive],
    ];
    const bx = 24, bw = 226, bh = 62, gap = 20, by = 110;
    let buttonY = by;
    modes.forEach(([key, label, run]) => {
        const selected = !!v.selected && key === v.selected;
        const controlEnabled = v.ready && v.armed && v.matched && !v.blocked;
        const disabled = !controlEnabled || v.busy && key !== 'OEM';
        const opts = { key: 'performance_flap_' + key, busy: disabled };
        if (selected) Object.assign(opts, { color: t.crit || RED, primary: true });
        drawActionButton(cv, G, t, bx, buttonY, bw, bh, label, disabled ? null : run, opts);
        buttonY += bh + gap;
    });
    return cv;
}

module.exports = { W, H, draw, drawRear, drawSmoke, drawValveFlaps, contain };
