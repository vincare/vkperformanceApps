'use strict';

const W = 1600, H = 520;
const RED = '#f32635';

function drawSmoke(cv, G, t, car, imageRect, now) {
    if (!car || !car.exhaustTips || car.exhaustTips.length !== 4) return;
    const seconds = (now || Date.now()) / 1000;
    const grey = '#aeb5bf';
    car.exhaustTips.forEach((tip, tipIndex) => {
        const originX = imageRect.x + tip[0] * imageRect.w;
        const originY = imageRect.y + tip[1] * imageRect.h;
        const outward = tipIndex < 2 ? -1 : 1;
        // Three small, staggered wisps per tip. All anchors are measured in each
        // source PNG's own coordinate space, then mapped through the contain rect.
        for (let puff = 0; puff < 3; puff++) {
            const phase = (seconds * 0.42 + puff / 3 + tipIndex * 0.067) % 1;
            const driftX = outward * (2 + phase * Math.min(14, imageRect.w * 0.035));
            const driftY = 4 + phase * Math.min(24, imageRect.h * 0.1);
            const sway = Math.sin(seconds * 2.2 + puff * 2.1 + tipIndex) * 1.5;
            const x = originX + driftX + sway;
            const y = originY + driftY;
            const radius = 3 + phase * Math.min(12, imageRect.h * 0.05);
            const fade = 1 - phase;
            cv.circle(x, y, radius, G.withAlpha(grey, 0.14 * fade));
            cv.circle(x, y, radius * 0.66, G.withAlpha(grey, 0.18 * fade));
            cv.circle(x, y, radius * 0.32, G.withAlpha(grey, 0.2 * fade));
        }
    });
}

function drawRear(cv, G, t, valve, car, now) {
    const x = 54, y = 78, w = 914, h = 314;
    const chassis = car && car.model ? car.model.chassis : 'BMW';
    G.panel(cv, t, x, y, w, h, chassis + ' REAR · EXHAUST SYSTEM');
    cv.text('SMOKE EFFECT · NOT MEASURED', x + w - 16, y + 42, 12, t.dim,
        { align: 'right', font: 'bold', spacing: 0.8 });
    const bounds = { x: x + 16, y: y + 56, w: w - 32, h: h - 56 };
    if (!car || !car.imageId || !(car.width > 0) || !(car.height > 0)) {
        cv.text('CAR IMAGE UNAVAILABLE', x + w / 2, y + h / 2 + 8, 20, t.dim,
            { align: 'center', font: 'bold', spacing: 1 });
        return;
    }
    // object-fit: contain equivalent: preserve the supplied PNG's full 3:2 frame.
    const imageRect = contain(bounds, car.width, car.height);
    cv.image(car.imageId, imageRect.x, imageRect.y, imageRect.w, imageRect.h);
    drawSmoke(cv, G, t, car, imageRect, now);
}

function contain(rect, width, height) {
    const scale = Math.min(rect.w / width, rect.h / height);
    const w = width * scale, h = height * scale;
    return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

function drawStatus(cv, G, t, valve) {
    const x = 1000, y = 78, w = 546, h = 314;
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
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);
    drawRear(cv, G, t, v, car, now);
    drawStatus(cv, G, t, v);

    const modes = [
        ['OPEN', 'OPEN VALVES', act.open],
        ['CLOSED', 'CLOSE VALVES', act.close],
        ['OEM', 'OEM CONTROL', act.oem],
        ['DRIVE', 'BY DRIVE MODE', act.drive],
    ];
    const bw = 260, bh = 54, gap = 22, by = bottom - bh;
    let bx = (W - (modes.length * bw + (modes.length - 1) * gap)) / 2;
    modes.forEach(([key, label, run]) => {
        const selected = !!v.selected && key === v.selected;
        const controlEnabled = v.ready && v.armed && v.matched && !v.blocked;
        const disabled = !controlEnabled || v.busy && key !== 'OEM';
        const opts = { key: 'performance_flap_' + key, busy: disabled };
        if (selected) Object.assign(opts, { color: t.crit || RED, primary: true });
        drawActionButton(cv, G, t, bx, by, bw, bh, label, disabled ? null : run, opts);
        bx += bw + gap;
    });
    return cv;
}

module.exports = { W, H, draw, drawRear, drawSmoke, contain };
