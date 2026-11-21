'use strict';

const W = 1600, H = 520;
const RED = '#f32635';

function drawRear(cv, G, t, valve) {
    const x = 54, y = 78, w = 914, h = 314;
    G.panel(cv, t, x, y, w, h, 'G20 REAR · EXHAUST SYSTEM');
    const cx = x + w / 2, top = y + 78;

    // Stylised rear view for the climate-sized MGU canvas: a G20 saloon silhouette,
    // drawn locally with primitives so it has no network or image dependency.
    cv.fillRect(x + 75, top + 216, w - 150, 2, G.withAlpha(RED, 0.32));
    cv.roundRect(cx - 325, top + 35, 650, 202, 62, '#101216');
    cv.strokeRoundRect(cx - 325, top + 35, 650, 202, 62, 2, G.withAlpha('#d5dbe5', 0.26));
    cv.quad([[cx - 248, top + 70], [cx - 194, top + 18], [cx + 194, top + 18], [cx + 248, top + 70]], '#171b22');
    cv.quad([[cx - 221, top + 66], [cx - 177, top + 28], [cx + 177, top + 28], [cx + 221, top + 66]], '#080b10');
    cv.line(cx - 232, top + 76, cx + 232, top + 76, 2, G.withAlpha('#d4d9e2', 0.28));
    cv.roundRect(cx - 300, top + 87, 600, 85, 22, '#1c2027');
    cv.line(cx - 284, top + 174, cx + 284, top + 174, 2, G.withAlpha('#ffffff', 0.16));

    // Slim red rear lamps and a restrained central roundel / model plaque.
    cv.roundRect(cx - 281, top + 93, 170, 18, 8, G.withAlpha(RED, 0.28));
    cv.roundRect(cx - 272, top + 97, 151, 7, 4, RED);
    cv.roundRect(cx + 111, top + 93, 170, 18, 8, G.withAlpha(RED, 0.28));
    cv.roundRect(cx + 121, top + 97, 151, 7, 4, RED);
    cv.circle(cx, top + 100, 18, '#11151a');
    cv.arc(cx, top + 100, 15, 17, 0, 360, G.withAlpha('#e1e5ed', 0.7));
    cv.line(cx - 10, top + 100, cx + 10, top + 100, 1.5, G.withAlpha('#e1e5ed', 0.6));
    cv.line(cx, top + 90, cx, top + 110, 1.5, G.withAlpha('#e1e5ed', 0.6));

    cv.roundRect(cx - 72, top + 123, 144, 36, 5, '#080a0d');
    cv.strokeRoundRect(cx - 72, top + 123, 144, 36, 5, 1.5, G.withAlpha('#e0e3e8', 0.36));
    cv.text('M340i', cx, top + 148, 21, t.text, { align: 'center', font: 'bold', spacing: 2 });
    cv.text('G20', cx + 94, top + 151, 13, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });

    // Diffuser and four decorative exhaust tips. The displayed valve angle is a
    // command/readback visual only; the current signal does not prove physical motion.
    cv.quad([[cx - 270, top + 176], [cx + 270, top + 176], [cx + 232, top + 227], [cx - 232, top + 227]], '#090b0e');
    for (let i = -2; i <= 2; i++) {
        if (i === 0) continue;
        cv.line(cx + i * 66, top + 185, cx + i * 66, top + 219, 2, G.withAlpha('#9ba2ad', 0.24));
    }
    const isKnown = valve && valve.visualState !== 'UNKNOWN';
    const open = isKnown && valve.visualState === 'OPEN';
    const closed = isKnown && valve.visualState === 'CLOSED';
    const tipXs = [cx - 248, cx - 193, cx + 193, cx + 248];
    tipXs.forEach((tx, i) => {
        const r = 20;
        cv.circle(tx, top + 211, r + 4, '#0b0d10');
        cv.arc(tx, top + 211, r, r + 3, 0, 360, G.withAlpha('#aab1bc', 0.64));
        cv.circle(tx, top + 211, r - 4, '#050608');
        // A single symbolic valve blade avoids asserting a count or location for the car's actuators.
        if (i === 3) {
            const angle = open ? 78 : closed ? 0 : 0;
            const rad = angle * Math.PI / 180;
            const dx = Math.cos(rad) * 13, dy = Math.sin(rad) * 13;
            const blade = open ? RED : closed ? '#bd2631' : '#69717c';
            cv.line(tx - dx, top + 211 - dy, tx + dx, top + 211 + dy, 3, blade);
            if (open) cv.circle(tx, top + 211, 3, RED);
        }
    });
    cv.text('VISUAL COMMAND INDICATOR · NOT A PHYSICAL POSITION SENSOR', cx, top + 258, 14,
        t.dim, { align: 'center', font: 'bold', spacing: 1 });
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

function draw(cv, G, t, v, act) {
    cv.clear(t.bg);
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG'], v.page || 0, [
        v.demo && { text: 'DEMO · NOT VEHICLE DATA', color: 'crit' },
    ]);
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);
    drawRear(cv, G, t, v);
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

module.exports = { W, H, draw };
