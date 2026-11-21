'use strict';

const W = 1600, H = 520;
const RED = '#f32635';
const TORQUE = '#f3b548';

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
function baselineRun(s) { return (s.runs || []).find((run) => run.at === s.baselineAt) || null; }
function contain(rect, width, height) {
    const scale = Math.min(rect.w / width, rect.h / height);
    const w = width * scale, h = height * scale;
    return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}
function drawButton(cv, G, t, x, y, w, h, label, run, active, enabled) {
    const color = active ? RED : G.withAlpha('#ffffff', 0.12);
    const disabled = enabled === false;
    cv.roundRect(x, y, w, h, 5, active ? G.withAlpha(RED, 0.88) : G.withAlpha('#ffffff', disabled ? 0.02 : 0.045));
    cv.strokeRoundRect(x, y, w, h, 5, 1.5, active ? RED : G.withAlpha('#ffffff', disabled ? 0.12 : 0.24));
    cv.text(label, x + w / 2, y + h / 2 + 5, 15, disabled ? t.dim : active ? '#ffffff' : t.text,
        { align: 'center', font: 'bold', spacing: 1.1 });
    if (cv.own && run && !disabled) cv.target(x, y, w, h, run, 'performance_dyno_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
}

function chart(cv, G, t, s, current, baseline) {
    const curves = [current, baseline].filter((run) => run && Array.isArray(run.curve) && run.curve.length > 1);
    const unit = s.powerUnit || 'hp', torqueUnit = s.torqueUnit || 'nm';
    const xMin = 1000;
    const maxPointRpm = curves.reduce((max, run) => Math.max(max, run.curve[run.curve.length - 1].rpm), 0);
    const configuredMax = Number(s.graphMaxRpm);
    const xMax = configuredMax > 0 ? configuredMax : maxPointRpm > 0
        ? clamp(nice(maxPointRpm + 1, 1000), 5000, 9000) : 8000;
    const powerMax = nice(Math.max(150, ...curves.reduce((all, run) => all.concat(run.curve.map((p) => powerValue(p.powerW, unit))), [])) * 1.12, 50);
    const minTorqueMax = torqueUnit === 'kgm' ? 15 : torqueUnit === 'lbft' ? 110 : 150;
    const torqueStep = torqueUnit === 'kgm' ? 5 : 50;
    const torqueMax = nice(Math.max(minTorqueMax, ...curves.reduce((all, run) => all.concat(run.curve.map((p) => p.torqueNm * torqueFactor(torqueUnit))), [])) * 1.12, torqueStep);
    const x = 112, y = 174, w = 820, h = 226;
    const X = (rpm) => x + (clamp(rpm, xMin, xMax) - xMin) / (xMax - xMin) * w;
    const YP = (value) => y + h - clamp(powerValue(value, unit) / powerMax, 0, 1) * h;
    const YT = (value) => y + h - clamp(value * torqueFactor(torqueUnit) / torqueMax, 0, 1) * h;

    for (let i = 0; i <= 4; i++) {
        const yy = y + h * i / 4;
        cv.fillRect(x, yy, w, 1, G.withAlpha(t.tick, i === 4 ? 0.55 : 0.25));
        cv.text(String(Math.round(powerMax * (1 - i / 4))), x - 12, yy + 6, 13, G.withAlpha(RED, 0.88), { align: 'right', font: 'bold' });
        cv.text(String(Math.round(torqueMax * (1 - i / 4))), x + w + 12, yy + 6, 13, G.withAlpha(TORQUE, 0.94), { font: 'bold' });
    }
    const rpmStep = xMax <= 6000 ? 1000 : 2000;
    for (let rpm = 2000; rpm < xMax; rpm += rpmStep) {
        cv.fillRect(X(rpm), y, 1, h, G.withAlpha(t.tick, 0.2));
        cv.text(String(rpm / 1000), X(rpm), y + h + 20, 13, t.dim, { align: 'center' });
    }
    cv.text(powerName(unit).toUpperCase(), x - 12, y - 12, 12, RED, { align: 'right', font: 'bold' });
    cv.text(torqueName(torqueUnit).toUpperCase(), x + w + 12, y - 12, 12, TORQUE, { font: 'bold' });
    cv.text('x1000 RPM', x + w / 2, y + h + 40, 12, t.dim, { align: 'center', font: 'bold', spacing: 0.8 });
    cv.fillRect(x, y + h, w, 2, G.withAlpha('#ffffff', 0.68));
    if (!curves.length) {
        cv.text(s.pullStatus === 'recording' ? 'RECORDING ROAD PULL' : 'NO DYNO RUN RECORDED', x + w / 2, y + 100, 22, t.dim,
            { align: 'center', font: 'bold', spacing: 1.1 });
        cv.text(s.pullStatus === 'recording' ? 'Keep one gear steady through the pull' : 'Hold one gear · flat road · full throttle · 1,500 rpm sweep',
            x + w / 2, y + 130, 14, t.dim, { align: 'center' });
        return;
    }
    function drawLine(run, key, mapY, color, width) {
        const points = run.curve.filter((p) => typeof p[key] === 'number' && isFinite(p[key]))
            .map((p) => [X(p.rpm), mapY(p[key])]);
        if (points.length > 1) cv.polyline(points, width, color);
        return points;
    }
    if (baseline && baseline !== current) {
        drawLine(baseline, 'powerW', YP, G.withAlpha(t.dim, 0.78), 2.5);
        drawLine(baseline, 'torqueNm', YT, G.withAlpha(t.dim, 0.55), 2);
    }
    if (current) {
        const pPoints = drawLine(current, 'powerW', YP, RED, 4);
        drawLine(current, 'torqueNm', YT, TORQUE, 3);
        if (s.ecuTorque) drawLine(current, 'ecuTorqueNm', YT, G.withAlpha(t.text, 0.58), 2);
        if (pPoints.length) {
            const peak = [X(current.peakPrpm), YP(current.peakP)];
            cv.circle(peak[0], peak[1], 7, '#ffffff');
            cv.circle(peak[0], peak[1], 4, RED);
        }
    }
}

function drawLegend(cv, G, t, current, baseline, ecuTorque) {
    const items = [[RED, 'POWER'], [TORQUE, 'ROAD TORQUE']];
    if (baseline) items.push([G.withAlpha(t.dim, 0.78), 'BASELINE']);
    if (ecuTorque && current && current.curve.some((point) => typeof point.ecuTorqueNm === 'number')) items.push([G.withAlpha(t.text, 0.62), 'ECU TORQUE']);
    let x = 48;
    items.forEach(([color, label]) => {
        cv.fillRect(x, 140, 18, 3, color);
        cv.text(label, x + 25, 146, 12, t.dim, { font: 'bold', spacing: 0.5 });
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

function drawSheet(cv, G, t, s, car, current, baseline) {
    G.panel(cv, t, 24, 92, 984, 398, 'ROAD DYNO · POWER / TORQUE');
    drawLegend(cv, G, t, current, baseline, s.ecuTorque);
    chart(cv, G, t, s, current, baseline);

    G.panel(cv, t, 1024, 92, 552, 210, s.pullStatus === 'recording' ? 'PULL IN PROGRESS' : 'DYNO TELEMETRY');
    const isPull = s.pullStatus === 'recording';
    if (isPull) {
        cv.circle(1538, 123, 6, Math.floor(Date.now() / 300) % 2 ? RED : G.withAlpha(RED, 0.3));
        cv.text('LIVE ESTIMATE', 1060, 163, 12, t.dim, { font: 'bold', spacing: 1.3 });
        const liveHp = powerValue(s.livePowerW || 0, s.powerUnit);
        cv.text(number(liveHp, 0), 1060, 213, 48, RED, { font: 'num' });
        cv.text(powerName(s.powerUnit), 1068 + cv.textWidth(number(liveHp, 0), 48, { font: 'num' }), 213, 18, t.dim);
        cv.text((s.rpm ? number(s.rpm, 0) : '0') + ' rpm  ·  ' + (s.speed ? number(s.speed, 0) : '0') + ' km/h', 1060, 236, 14, t.dim, { font: 'bold' });
    } else if (current) {
        const hp = powerValue(current.peakP, s.powerUnit);
        const torque = current.peakT * torqueFactor(s.torqueUnit);
        cv.text('PEAK POWER', 1060, 162, 12, t.dim, { font: 'bold', spacing: 1.2 });
        cv.text(number(hp, 0), 1060, 211, 38, RED, { font: 'num' });
        cv.text(powerName(s.powerUnit), 1068 + cv.textWidth(number(hp, 0), 38, { font: 'num' }), 211, 16, t.dim);
        cv.text('@ ' + number(current.peakPrpm, 0) + ' rpm', 1060, 234, 12, t.dim);
        cv.text('PEAK TORQUE', 1310, 162, 12, t.dim, { font: 'bold', spacing: 1.2 });
        cv.text(number(torque, torqueDigits(s.torqueUnit)), 1310, 211, 36, TORQUE, { font: 'num' });
        cv.text(torqueName(s.torqueUnit), 1318 + cv.textWidth(number(torque, torqueDigits(s.torqueUnit)), 36, { font: 'num' }), 211, 15, t.dim);
        cv.text('@ ' + number(current.peakTrpm, 0) + ' rpm', 1310, 234, 12, t.dim);
        const wheel = powerValue(current.peakP * (1 - current.loss / 100), s.powerUnit);
        cv.text('CRANK ' + number(hp, 0) + ' ' + powerName(s.powerUnit) + '   ·   WHEELS ' + number(wheel, 0) + ' ' + powerName(s.powerUnit),
            1060, 261, 12, t.dim, { font: 'bold', spacing: 0.2 });
    } else {
        cv.text('PEAK POWER', 1060, 162, 12, t.dim, { font: 'bold', spacing: 1.2 });
        cv.text('0', 1060, 211, 38, RED, { font: 'num' });
        cv.text(powerName(s.powerUnit), 1086, 211, 16, t.dim);
        cv.text('PEAK TORQUE', 1310, 162, 12, t.dim, { font: 'bold', spacing: 1.2 });
        cv.text('0', 1310, 211, 36, TORQUE, { font: 'num' });
        cv.text(torqueName(s.torqueUnit), 1336, 211, 15, t.dim);
        cv.text(s.demo ? 'DEMO · ROAD RECORDING DISABLED' : (s.gateText || 'WAITING FOR LIVE VEHICLE SIGNALS'),
            1060, 245, 12, t.dim, { font: 'bold', spacing: 0.4 });
    }
    const baselineLabel = baseline ? 'BASELINE SET' : 'NO BASELINE';
    cv.text(baselineLabel, 1060, 286, 11, baseline ? TORQUE : t.dim, { font: 'bold', spacing: 0.9 });
    drawCar(cv, G, t, car, { x: 1048, y: 306, w: 528, h: 168 });
}

function drawRuns(cv, G, t, s, car, current, baseline, actions) {
    G.panel(cv, t, 24, 92, 1018, 398, 'SAVED ROAD RUNS');
    const columns = [48, 270, 478, 675, 850];
    ['DATE / TIME', 'PEAK POWER', 'PEAK TORQUE', 'SPEED', 'SETUP'].forEach((label, i) =>
        cv.text(label, columns[i], 160, 11, t.dim, { font: 'bold', spacing: 0.7 }));
    const runs = s.runs || [];
    if (!runs.length) {
        cv.text('NO SAVED RUNS YET', 530, 260, 20, t.dim, { align: 'center', font: 'bold', spacing: 1.2 });
        cv.text('A qualifying full-throttle pull is saved here automatically.', 530, 286, 13, t.dim, { align: 'center' });
    }
    runs.slice(0, 7).forEach((run, index) => {
        const y = 192 + index * 39;
        const date = new Date(run.at);
        const pad = (value) => String(value).padStart(2, '0');
        const selected = current && current.at === run.at;
        const isBaseline = baseline && baseline.at === run.at;
        if (selected) cv.roundRect(36, y - 22, 994, 30, 4, G.withAlpha(RED, 0.17));
        if (isBaseline) cv.fillRect(36, y - 22, 3, 30, TORQUE);
        const hp = number(powerValue(run.peakP, s.powerUnit), 0) + ' ' + powerName(s.powerUnit);
        const torque = number(run.peakT * torqueFactor(s.torqueUnit), torqueDigits(s.torqueUnit)) + ' ' + torqueName(s.torqueUnit);
        const setup = number(run.weight, 0) + ' kg · ' + number(run.loss, 0) + '%';
        cv.text(pad(date.getDate()) + '.' + pad(date.getMonth() + 1) + '  ' + pad(date.getHours()) + ':' + pad(date.getMinutes()), columns[0], y, 14, t.text);
        cv.text(hp + ' @ ' + number(run.peakPrpm, 0), columns[1], y, 14, selected ? RED : t.text, { font: 'bold' });
        cv.text(torque + ' @ ' + number(run.peakTrpm, 0), columns[2], y, 14, selected ? TORQUE : t.text, { font: 'bold' });
        cv.text(number(run.v0, 0) + '–' + number(run.v1, 0) + ' km/h', columns[3], y, 13, t.dim);
        cv.text(setup, columns[4], y, 12, t.dim);
        if (isBaseline) cv.text('BASE', 990, y, 10, TORQUE, { align: 'right', font: 'bold' });
        if (cv.own && actions.select) cv.target(36, y - 23, 994, 32, () => actions.select(run.at), 'performance_run_' + index, 4);
    });
    G.panel(cv, t, 1058, 92, 518, 190, 'SELECTED RUN');
    if (current) {
        const hp = powerValue(current.peakP, s.powerUnit);
        const torque = current.peakT * torqueFactor(s.torqueUnit);
        cv.text(number(hp, 0), 1090, 181, 42, RED, { font: 'num' });
        cv.text(powerName(s.powerUnit), 1098 + cv.textWidth(number(hp, 0), 42, { font: 'num' }), 181, 16, t.dim);
        cv.text(number(torque, torqueDigits(s.torqueUnit)), 1340, 181, 38, TORQUE, { font: 'num' });
        cv.text(torqueName(s.torqueUnit), 1348 + cv.textWidth(number(torque, torqueDigits(s.torqueUnit)), 38, { font: 'num' }), 181, 15, t.dim);
        cv.text('PEAK POWER', 1090, 202, 11, t.dim, { font: 'bold' });
        cv.text('PEAK TORQUE', 1340, 202, 11, t.dim, { font: 'bold' });
        const wheel = powerValue(current.peakP * (1 - current.loss / 100), s.powerUnit);
        cv.text('WHEELS EST.  ' + number(wheel, 0) + ' ' + powerName(s.powerUnit) + '  ·  ' + current.loss + '% LOSS',
            1090, 236, 11, t.dim, { font: 'bold', spacing: 0.2 });
        drawCar(cv, G, t, car, { x: 1058, y: 294, w: 518, h: 142 });
    } else {
        cv.text('SELECT A RUN TO SEE ITS DETAILS', 1317, 212, 13, t.dim, { align: 'center', font: 'bold' });
        drawCar(cv, G, t, car, { x: 1058, y: 294, w: 518, h: 142 });
    }
    const currentIsBase = !!(current && baseline && current.at === baseline.at);
    drawButton(cv, G, t, 1090, 447, 214, 30, baseline && currentIsBase ? 'CLEAR BASELINE' : 'SET BASELINE', actions.toggleBaseline, !!(baseline && currentIsBase), !!current);
    drawButton(cv, G, t, 1320, 447, 224, 30, 'NEXT SAVED RUN', actions.nextRun, false, runs.length > 0);
}

function draw(cv, G, t, s, car, actions) {
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'DYNO MODE', 'DRAG RUN'], 2, [
        s.demo && { text: 'DEMO · NO ROAD DATA', color: 'crit' },
    ]);
    drawButton(cv, G, t, 24, 52, 156, 30, s.view === 'runs' ? 'DYNO SHEET' : 'SAVED RUNS', actions.toggleView, false);
    const current = selectedRun(s), baseline = baselineRun(s);
    if (s.view === 'runs') drawRuns(cv, G, t, s, car, current, baseline, actions);
    else drawSheet(cv, G, t, s, car, current, baseline);
    if (s.view !== 'runs') {
        drawButton(cv, G, t, 798, 104, 92, 28,
            baseline && current && baseline.at === current.at ? 'BASELINE ON' : 'SET BASE', current ? actions.toggleBaseline : null,
            !!(baseline && current && baseline.at === current.at));
        drawButton(cv, G, t, 898, 104, 84, 28, 'RESET', actions.clear, false);
    }
    return cv;
}

module.exports = { W, H, draw, selectedRun, baselineRun, contain, powerValue, torqueFactor };
