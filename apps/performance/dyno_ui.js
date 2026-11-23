'use strict';

const Sheet = require('./flap_ui');

const W = 1600, H = 520;
const RED = '#f32635';
// Cool, restrained chart colours inspired by the cleaner Virtual Dyno sheet.
const POWER = '#f32635';
const TORQUE = '#ff737d';
const ECU_TORQUE = '#ffd0d4';
const SLANT = Sheet.SLANT;

function nice(value, step) { return Math.max(step, Math.ceil(value / step) * step); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function number(value, digits) {
    if (typeof value !== 'number' || !isFinite(value)) return '0';
    const scale = Math.pow(10, digits || 0);
    return String(Math.round(value * scale) / scale);
}
function powerValue(powerW, unit) {
    const divisor = unit === 'kw' ? 1000 : unit === 'ps' ? 735.5 : 745.7;
    return powerW / divisor;
}
function powerName(unit) { return unit === 'kw' ? 'kW' : unit === 'ps' ? 'PS' : 'hp'; }
function torqueFactor(unit) { return unit === 'lbft' ? 0.73756 : unit === 'kgm' ? 1 / 9.80665 : 1; }
function torqueName(unit) { return unit === 'lbft' ? 'lb-ft' : unit === 'kgm' ? 'kgm' : 'Nm'; }
function torqueDigits(unit) { return unit === 'kgm' ? 1 : 0; }
function selectedRun(s) {
    if (s.cleared) return null;
    return (s.runs || []).find((run) => run.at === s.selectedAt) || (s.runs || [])[0] || null;
}
function contain(rect, width, height) {
    const scale = Math.min(rect.w / width, rect.h / height);
    const w = width * scale, h = height * scale;
    return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}
function runStamp(at) {
    const d = new Date(at);
    if (!isFinite(d.getTime())) return '--';
    const p2 = (n) => String(n).padStart(2, '0');
    return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear() +
        ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

// Chart drawn inside a parallelogram, sheared by `sh` px over its height so its
// edges run parallel to the stage slab's diagonal edges.
function chart(cv, G, t, s, current, rect) {
    const curves = [current].filter((run) => run && Array.isArray(run.curve) && run.curve.length > 1);
    const unit = s.powerUnit || 'hp', torqueUnit = s.torqueUnit || 'nm';
    const xMin = 1000;
    const maxPointRpm = curves.reduce((max, run) => Math.max(max, run.curve[run.curve.length - 1].rpm), 0);
    const configuredMax = Number(s.graphMaxRpm);
    const xMax = configuredMax > 0 ? configuredMax : maxPointRpm > 0
        ? clamp(nice(maxPointRpm + 750, 1000), 8000, 9000) : 8000;
    const powerMax = nice(Math.max(150, ...curves.reduce((all, run) => all.concat(run.curve.map((p) => powerValue(p.powerW, unit))), [])) * 1.12, 50);
    const minTorqueMax = torqueUnit === 'kgm' ? 15 : torqueUnit === 'lbft' ? 110 : 150;
    const torqueStep = torqueUnit === 'kgm' ? 5 : 50;
    const torqueMax = nice(Math.max(minTorqueMax, ...curves.reduce((all, run) => all.concat(run.curve.map((p) => {
        const roadTorque = p.torqueNm * torqueFactor(torqueUnit);
        const ecuTorque = s.ecuTorque && typeof p.ecuTorqueNm === 'number' ? p.ecuTorqueNm * torqueFactor(torqueUnit) : 0;
        return Math.max(roadTorque, ecuTorque);
    })), [])) * 1.12, torqueStep);
    const x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    const sh = Math.round(h * 0.27);
    const sx = (px, py) => px - (py - y) / h * sh;
    const X = (rpm) => x + (clamp(rpm, xMin, xMax) - xMin) / (xMax - xMin) * w;
    const YP = (value) => y + h - clamp(powerValue(value, unit) / powerMax, 0, 1) * h;
    const YT = (value) => y + h - clamp(value * torqueFactor(torqueUnit) / torqueMax, 0, 1) * h;
    const shearPt = (p) => [p[0] - (p[1] - y) / h * sh, p[1]];

    cv.quad([[x, y], [x + w, y], [x + w - sh, y + h], [x - sh, y + h]], '#0A0F17');
    cv.line(x, y, x + w, y, 1, G.withAlpha('#A9B8CC', 0.16));
    cv.line(x - sh, y + h, x + w - sh, y + h, 1, G.withAlpha('#A9B8CC', 0.16));
    cv.line(x, y, x - sh, y + h, 1, G.withAlpha('#A9B8CC', 0.16));
    cv.line(x + w, y, x + w - sh, y + h, 1, G.withAlpha('#A9B8CC', 0.16));

    // Match DYNO's six clear scale marks (five equal intervals).
    for (let i = 0; i <= 5; i++) {
        const fraction = i / 5;
        const yy = y + h * fraction;
        cv.line(sx(x, yy), yy, sx(x + w, yy), yy, 1, G.withAlpha(t.tick, i === 5 ? 0.5 : 0.24));
        cv.line(sx(x - 5, yy), yy, sx(x, yy), yy, 1.5, G.withAlpha(POWER, 0.8));
        cv.line(sx(x + w, yy), yy, sx(x + w + 5, yy), yy, 1.5, G.withAlpha(TORQUE, 0.82));
        cv.text(String(Math.round(powerMax * (1 - fraction))), sx(x - 12, yy), yy + 5, 15, POWER,
            { align: 'right', font: 'bold' });
        cv.text(number(torqueMax * (1 - fraction), torqueDigits(torqueUnit)), sx(x + w + 12, yy), yy + 5, 15,
            G.withAlpha(TORQUE, 0.96), { font: 'bold' });
    }
    // Every 1,000 rpm, with both ends of the displayed range labelled.
    const rpmTicks = [];
    for (let rpm = xMin; rpm <= xMax; rpm += 1000) rpmTicks.push(rpm);
    if (rpmTicks[rpmTicks.length - 1] < xMax) rpmTicks.push(xMax);
    rpmTicks.forEach((rpm, index) => {
        const xx = X(rpm);
        cv.line(sx(xx, y), y, sx(xx, y + h), y + h, 1,
            G.withAlpha(t.tick, index === 0 || rpm === xMax ? 0.3 : 0.18));
        cv.line(sx(xx, y + h), y + h, sx(xx, y + h), y + h + 5, 1.5, G.withAlpha(t.dim, 0.75));
        const rpmLabel = rpm % 1000 === 0 ? String(rpm / 1000) : number(rpm / 1000, 1);
        cv.text(rpmLabel, sx(xx, y + h), y + h + 20, 15, t.dim, { align: 'center', font: 'bold' });
    });
    cv.text(powerName(unit).toUpperCase(), x - 12, y - 12, 12, POWER, { align: 'right', font: 'bold' });
    cv.text(torqueName(torqueUnit).toUpperCase(), x + w - 8, y + 18, 12, TORQUE, { align: 'right', font: 'bold' });
    cv.text('x1000 RPM', sx(x + w / 2, y + h), y + h + 42, 13, t.dim, { align: 'center', font: 'bold', spacing: 0.8 });
    cv.line(sx(x, y + h), y + h, sx(x + w, y + h), y + h, 2, G.withAlpha('#ffffff', 0.68));
    if (!curves.length) {
        const cx = sx(x + w / 2, y + 100);
        cv.text(s.pullStatus === 'recording' ? 'RECORDING ROAD PULL' : 'NO DYNO RUN RECORDED', cx, y + 100, 22, t.dim,
            { align: 'center', font: 'bold', spacing: 1.1 });
        cv.text(s.pullStatus === 'recording' ? 'Keep one gear steady through the pull' : 'Hold one gear · flat road · full throttle · 1,500 rpm sweep',
            cx, y + 130, 14, t.dim, { align: 'center' });
        return;
    }
    function linePoints(run, key, mapY) {
        const samples = run.curve.filter((p) => typeof p.rpm === 'number' && isFinite(p.rpm) &&
            typeof p[key] === 'number' && isFinite(p[key])).slice().sort((a, b) => a.rpm - b.rpm);
        const points = [];
        for (let i = 1; i < samples.length; i++) {
            const a = samples[i - 1], b = samples[i];
            if (b.rpm <= a.rpm || b.rpm < xMin || a.rpm > xMax) continue;
            const atRpm = (rpm) => a[key] + (b[key] - a[key]) * (rpm - a.rpm) / (b.rpm - a.rpm);
            const from = Math.max(a.rpm, xMin), to = Math.min(b.rpm, xMax);
            const first = shearPt([X(from), mapY(atRpm(from))]), last = shearPt([X(to), mapY(atRpm(to))]);
            const previous = points[points.length - 1];
            if (!previous || Math.abs(previous[0] - first[0]) > 0.01 || Math.abs(previous[1] - first[1]) > 0.01) points.push(first);
            points.push(last);
        }
        return points;
    }
    function drawLine(run, key, mapY, color, width) {
        const points = linePoints(run, key, mapY);
        if (points.length > 1) cv.polyline(points, width, color);
        return points;
    }
    if (current) {
        const pPoints = linePoints(current, 'powerW', YP);
        if (pPoints.length > 1) {
            cv.polyline(pPoints, 7, G.withAlpha(POWER, 0.14));
            cv.polyline(pPoints, 3.4, POWER);
        }
        const tPoints = linePoints(current, 'torqueNm', YT);
        if (tPoints.length > 1) {
            cv.polyline(tPoints, 5.5, G.withAlpha(TORQUE, 0.12));
            cv.polyline(tPoints, 2.8, TORQUE);
        }
        if (s.ecuTorque) drawLine(current, 'ecuTorqueNm', YT, G.withAlpha(ECU_TORQUE, 0.64), 1.8);
        if (current.peakPrpm >= xMin && current.peakPrpm <= xMax) {
            const peak = shearPt([X(current.peakPrpm), YP(current.peakP)]);
            cv.circle(peak[0], peak[1], 8, G.withAlpha('#071019', 0.94));
            cv.circle(peak[0], peak[1], 6, G.withAlpha('#FFFFFF', 0.96));
            cv.circle(peak[0], peak[1], 3.5, POWER);
        }
        if (tPoints.length && current.peakTrpm >= xMin && current.peakTrpm <= xMax) {
            const peak = shearPt([X(current.peakTrpm), YT(current.peakT)]);
            cv.circle(peak[0], peak[1], 7, G.withAlpha('#071019', 0.94));
            cv.circle(peak[0], peak[1], 5, G.withAlpha('#FFFFFF', 0.92));
            cv.circle(peak[0], peak[1], 3, TORQUE);
        }
    }
}

function drawLegend(cv, G, t, current, ecuTorque, x0, y0) {
    const items = [[POWER, 'POWER'], [TORQUE, 'ROAD TORQUE']];
    if (ecuTorque && current && current.curve.some((point) => typeof point.ecuTorqueNm === 'number')) items.push([G.withAlpha(ECU_TORQUE, 0.64), 'ECU TORQUE']);
    let x = x0;
    items.forEach(([color, label]) => {
        cv.roundRect(x, y0, 18, 5, 2, color);
        cv.text(label, x + 25, y0 + 7, 12, t.dim, { font: 'bold', spacing: 0.5 });
        x += cv.textWidth(label, 12, { font: 'bold', spacing: 0.5 }) + 52;
    });
}

function drawCar(cv, G, t, car, rect) {
    if (!car || !car.imageId || !(car.width > 0) || !(car.height > 0)) {
        cv.text('SIDE VIEW UNAVAILABLE', rect.x + rect.w / 2, rect.y + rect.h / 2, 14, t.dim, { align: 'center', font: 'bold' });
        return;
    }
    const image = contain(rect, car.width, car.height);
    cv.image(car.imageId, image.x, image.y, image.w, image.h);
}

function drawSheet(cv, G, t, s, car, current, actions) {
    const y0 = (G.TOP || 44) + 8, y1 = H - 8, h = y1 - y0;
    const xAt = (xTop, y) => xTop - (y - y0) / h * SLANT;
    const isPull = s.pullStatus === 'recording';
    const hasData = !!(current || isPull);

    // 1. Dark backdrop + subtle red hex lines across the whole background
    cv.fillRect(0, y0, W, h, t.bg);
    Sheet.drawHexMesh(cv, G, y0, y1, false);

    // 2. Slanted black stage slab — the dyno chart is the hero on it
    const slabX = 294, slabW = 740, slabS = Math.round(SLANT * (h - 12) / h);
    Sheet.para(cv, slabX, y0 + 8, slabW, y1 - 4, slabS, '#000000');
    cv.line(slabX, y0 + 8, slabX + slabW, y0 + 8, 2, G.withAlpha('#f32635', 0.4));
    cv.line(slabX, y0 + 8, slabX - slabS, y1 - 4, 1.5, G.withAlpha('#f32635', 0.25));
    cv.line(slabX + slabW - slabS, y1 - 4, slabX + slabW, y0 + 8, 1.5, G.withAlpha('#f32635', 0.25));

    cv.text('ROAD DYNO STATS', 316, y0 + 36, 15, t.dim, { font: 'bold', spacing: 1.4, literal: true });
    drawLegend(cv, G, t, current, s.ecuTorque, 316, y0 + 58);
    chart(cv, G, t, s, current, { x: 338, y: y0 + 106, w: 560, h: 270 });
    drawCar(cv, G, t, car, { x: 820, y: y0 + 14, w: 175, h: 88 });

    // 3. Title tag + back chip
    const tagX = 40, tagY = y0 + 24, tagW = Sheet.titleTagWidth(cv, 'DYNO RUN', 24, 196), tagH = 46, tagSlant = 15;
    Sheet.para(cv, tagX, tagY, tagW, tagY + tagH, tagSlant, G.withAlpha('#c8192b', 0.94));
    cv.text('DYNO RUN', tagX + (tagW - tagSlant) / 2, tagY + 32, 24, '#ffffff',
        { align: 'center', font: 'num', spacing: 1.6, literal: true });
    Sheet.drawChip(cv, G, tagX, tagY + tagH + 14, 196, 'ALL DYNO RUNS',
        { icon: 'fwd', run: actions && actions.toggleView, key: 'performance_dyno_runs' });
    Sheet.drawBackChip(cv, G, tagX, tagY, tagH, actions, 'performance_dyno_back', 54);

    // 4. Smooth diagonal panel on the right (same ribbon as EXHAUST SYSTEM)
    const ribX = 1128;
    Sheet.para(cv, ribX,       y0, 210, y1, SLANT, '#2a0b12');
    Sheet.para(cv, ribX + 210, y0, 112, y1, SLANT, '#1b070c');
    Sheet.para(cv, ribX + 322, y0, 62,  y1, SLANT, '#8c1122');
    Sheet.para(cv, ribX + 384, y0, 56,  y1, SLANT, '#d91c33');

    // 5. Result rows along the diagonal: icon, label, big value, detail, two bars
    const loss = current ? current.loss : (typeof s.loss === 'number' ? s.loss : 15);
    const enginePowerW = isPull ? (s.livePowerW || 0) : current ? current.peakP : 0;
    const torqueNm = isPull ? (s.liveTorqueNm || 0) : current ? current.peakT : 0;
    const powerRpm = isPull ? (s.rpm || 0) : current ? current.peakPrpm : 0;
    const torqueRpm = isPull ? (s.rpm || 0) : current ? current.peakTrpm : 0;
    const power = powerValue(enginePowerW, s.powerUnit);
    const torque = torqueNm * torqueFactor(s.torqueUnit);
    const wheelPower = powerValue(enginePowerW * (1 - loss / 100), s.powerUnit);
    const powerUnit = powerName(s.powerUnit), torqueUnit = torqueName(s.torqueUnit);
    const detailPower = isPull ? 'LIVE ROAD ESTIMATE' : current ? 'ROAD ESTIMATE · @ ' + number(powerRpm, 0) + ' RPM' : 'NO RUN RECORDED';
    const detailTorque = isPull ? 'ROAD ESTIMATE · @ ' + number(torqueRpm, 0) + ' RPM' : current ? 'ROAD ESTIMATE · @ ' + number(torqueRpm, 0) + ' RPM' : 'NO RUN RECORDED';
    const detailWheels = hasData ? number(loss, 0) + '% LOSS ESTIMATE' : 'NO RUN RECORDED';
    const speedValue = isPull
        ? (s.speed != null ? number(s.speed, 0) + ' KM/H' : '—')
        : (current && typeof current.v0 === 'number' && typeof current.v1 === 'number')
            ? number(current.v0, 0) + ' - ' + number(current.v1, 0) + ' KM/H' : '—';
    const detailSpeed = isPull ? 'LIVE VEHICLE SPEED' : current ? 'PULL SPEED RANGE' : 'NO RUN RECORDED';
    const rows = [
        ['DRIVE', 'ENGINE POWER', '~' + number(power, 0) + ' ' + powerUnit, detailPower, POWER],
        ['OEM', 'TORQUE', '~' + number(torque, 0) + ' ' + torqueUnit, detailTorque, TORQUE],
        ['WHEELS', 'WHEELS POWER', '~' + number(wheelPower, 0) + ' ' + powerUnit, detailWheels, POWER],
        ['SPEED', 'SPEED', speedValue, detailSpeed, POWER],
    ];
    rows.forEach(([iconKey, label, value, detail, color], i) => {
        const ry = y0 + 58 + i * 80;
        const rx = xAt(ribX + 26, ry);
        Sheet.modeIcon(cv, G, t, iconKey, rx + 12, ry + 13, 32,
            hasData ? G.withAlpha('#c8ced8', 0.9) : G.withAlpha('#c8ced8', 0.5));
        cv.text(label, rx + 44, ry, 12, G.withAlpha('#e8c8ce', 0.55),
            { font: 'bold', spacing: 1.0, literal: true });
        cv.text(value, rx + 44, ry + 30, 24, hasData ? color : G.withAlpha('#8c94a0', 0.5),
            { font: 'num', spacing: 0.5, literal: true });
        cv.text(detail, rx + 44, ry + 53, 10.5, G.withAlpha('#e8c8ce', 0.42),
            { font: 'bold', spacing: 0.4, literal: true });
        Sheet.drawBarSegs(cv, G, rx + 44, ry + 62, hasData);
    });

    // 6. Lower status block: pull state, last run stamp and gate hint
    const setupY = y1 - 84, setupX = xAt(ribX + 12, setupY);
    const stateLabel = isPull ? 'LIVE' : current ? 'LAST RUN' : 'STANDBY';
    cv.text('STATE · ' + stateLabel, setupX, setupY + 14, 20, '#ffffff',
        { font: 'bold', spacing: 1.1, literal: true });
    if (isPull) {
        const tw = cv.textWidth('STATE · LIVE', 20, { font: 'bold', spacing: 1.1 });
        cv.circle(setupX + tw + 18, setupY + 8, 5,
            Math.floor(Date.now() / 300) % 2 ? '#ff243b' : G.withAlpha('#ff243b', 0.3));
    }
    const sub = isPull ? 'RECORDING ROAD PULL'
        : current ? runStamp(current.at)
        : 'HOLD ONE GEAR · FLAT ROAD';
    cv.text(sub, setupX, setupY + 40, 13, '#ff8595', { font: 'bold', spacing: 0.8, literal: true });
    cv.text(s.gateText || (isPull ? 'KEEP ONE GEAR STEADY' : 'FULL THROTTLE · 1,500 RPM SWEEP'),
        setupX, setupY + 64, 10.5, G.withAlpha('#e8c8ce', 0.5), { font: 'bold', spacing: 0.5, literal: true });
}

// Saved-runs list: same shell as the dyno sheet (hex mesh, slanted slab, red tag,
// right ribbon) but the slab carries the run table instead of the chart — no car.
function drawRuns(cv, G, t, s, actions) {
    const y0 = (G.TOP || 44) + 8, y1 = H - 8, h = y1 - y0;
    const xAt = (xTop, y) => xTop - (y - y0) / h * SLANT;
    const runs = (s.runs || []).slice(0, 7);
    const selRun = (s.runs || []).find((r) => r.at === s.selectedAt) || (s.runs || [])[0] || null;

    cv.fillRect(0, y0, W, h, t.bg);
    Sheet.drawHexMesh(cv, G, y0, y1, false);

    const slabX = 294, slabW = 740, slabS = Math.round(SLANT * (h - 12) / h);
    Sheet.para(cv, slabX, y0 + 8, slabW, y1 - 4, slabS, '#000000');
    cv.line(slabX, y0 + 8, slabX + slabW, y0 + 8, 2, G.withAlpha('#f32635', 0.4));
    cv.line(slabX, y0 + 8, slabX - slabS, y1 - 4, 1.5, G.withAlpha('#f32635', 0.25));
    cv.line(slabX + slabW - slabS, y1 - 4, slabX + slabW, y0 + 8, 1.5, G.withAlpha('#f32635', 0.25));

    cv.text('SAVED DYNO RUNS', 316, y0 + 36, 15, t.dim, { font: 'bold', spacing: 1.4, literal: true });
    if (!runs.length) {
        cv.text('NO RUNS YET', 610, y0 + 236, 20, t.dim,
            { align: 'center', font: 'bold', spacing: 1.1, literal: true });
        cv.text('HOLD ONE GEAR · FLAT ROAD · FULL THROTTLE', 610, y0 + 264, 12,
            G.withAlpha('#e8c8ce', 0.45), { align: 'center', font: 'bold', spacing: 0.6, literal: true });
    }
    runs.forEach((run, i) => {
        const ry = y0 + 78 + i * 60;
        const sel = selRun && run.at === selRun.at;
        if (sel) {
            Sheet.para(cv, 306, ry - 26, 620, ry + 30, 20, G.withAlpha('#ffffff', 0.1));
            Sheet.para(cv, 306, ry - 26, 6, ry + 30, 20, '#ff243b');
        }
        cv.text(runStamp(run.at), 330, ry - 4, 15, sel ? '#ffffff' : G.withAlpha('#e8c8ce', 0.8),
            { font: 'bold', spacing: 0.8, literal: true });
        if (s.baselineAt === run.at) cv.text('BASELINE', 890, ry - 4, 12, '#ff243b',
            { align: 'right', font: 'bold', spacing: 1.0, literal: true });
        const line = Math.round(powerValue(run.peakP, s.powerUnit)) + ' ' + powerName(s.powerUnit).toUpperCase()
            + ' @ ' + Math.round(run.peakPrpm) + ' RPM    ' + Math.round(run.peakT * torqueFactor(s.torqueUnit))
            + ' ' + torqueName(s.torqueUnit).toUpperCase() + ' @ ' + Math.round(run.peakTrpm) + ' RPM    '
            + Math.round(run.v0) + '-' + Math.round(run.v1) + ' KM/H    ' + Math.round(run.loss) + '% LOSS';
        cv.text(line, 330, ry + 18, 11.5, G.withAlpha('#e8c8ce', 0.5),
            { font: 'bold', spacing: 0.4, literal: true });
        if (cv.own && actions && actions.select) {
            cv.target(300, ry - 26, 632, 56, () => actions.select(run.at), 'performance_dynorun_' + i, 10, true);
        }
    });

    // Tag + back chip (back returns to the dyno sheet)
    const tagX = 40, tagY = y0 + 24, tagW = Sheet.titleTagWidth(cv, 'SAVED RUNS', 24, 216), tagH = 46, tagSlant = 15;
    Sheet.para(cv, tagX, tagY, tagW, tagY + tagH, tagSlant, G.withAlpha('#c8192b', 0.94));
    cv.text('SAVED RUNS', tagX + (tagW - tagSlant) / 2, tagY + 32, 24, '#ffffff',
        { align: 'center', font: 'num', spacing: 1.6, literal: true });
    Sheet.drawBackChip(cv, G, tagX, tagY, tagH,
        { back: actions && actions.toggleView }, 'performance_dynoruns_back');

    // Right ribbon — control rows, same style as the mode rows
    const ribX = 1128;
    Sheet.para(cv, ribX,       y0, 210, y1, SLANT, '#2a0b12');
    Sheet.para(cv, ribX + 210, y0, 112, y1, SLANT, '#1b070c');
    Sheet.para(cv, ribX + 322, y0, 62,  y1, SLANT, '#8c1122');
    Sheet.para(cv, ribX + 384, y0, 56,  y1, SLANT, '#d91c33');

    const rows = [
        ['NEXT RUN',   actions && actions.nextRun, 'performance_druns_next',  'next'],
        ['CLEAR RUNS', actions && actions.clear,   'performance_druns_clear', 'clear'],
    ];
    rows.forEach(([label, run, key, fkey], i) => {
        const ry = y0 + 68 + i * 106;
        const rx = xAt(ribX + 26, ry);
        const redBar = s.flashKey === fkey && Date.now() - s.flashAt < 1000;
        const ic = redBar ? '#ffffff' : G.withAlpha('#c8ced8', 0.78);
        cv.text(label, rx + 4, ry + 8, 21, ic, { font: 'bold', spacing: 1.2, literal: true });
        Sheet.drawBarSegs(cv, G, rx + 4, ry + 18, redBar);
        if (cv.own && run) cv.target(rx - 18, ry - 22, 348, 64,
            () => { if (actions.flash) actions.flash(fkey); run(); }, key, 10, true);
    });

    // Status block
    const setupY = y1 - 102, setupX = xAt(ribX + 12, setupY);
    cv.text('RUNS · ' + (s.runs || []).length, setupX, setupY + 14, 20, '#ffffff',
        { font: 'bold', spacing: 1.1, literal: true });
    cv.text(selRun ? runStamp(selRun.at) : 'NONE SELECTED', setupX, setupY + 40, 13, '#ff8595',
        { font: 'bold', spacing: 0.8, literal: true });
    cv.text('TAP A RUN · BACK SHOWS IT', setupX, setupY + 64, 10.5,
        G.withAlpha('#e8c8ce', 0.5), { font: 'bold', spacing: 0.5, literal: true });
}

function draw(cv, G, t, s, car, actions) {
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'RACE MODES', 'CAR DATA', 'WARMUP'], 2, [
        s.demo && { text: 'DEMO · NO ROAD DATA', color: 'crit' },
    ]);
    G.sectionRule(cv, t, 24, G.TOP || 44, W - 48, t.stripes || RED);
    if (s.view === 'runs') drawRuns(cv, G, t, s, actions);
    else drawSheet(cv, G, t, s, car, selectedRun(s), actions);
    return cv;
}

module.exports = { W, H, draw, selectedRun, contain, powerValue, torqueFactor };
