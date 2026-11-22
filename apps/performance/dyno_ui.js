'use strict';

const W = 1600, H = 520;
const RED = '#f32635';
// Cool, restrained chart colours inspired by the cleaner Virtual Dyno sheet.
const POWER = '#f32635';
const TORQUE = '#ff737d';
const ECU_TORQUE = '#ffd0d4';

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
function chart(cv, G, t, s, current) {
    const curves = [current].filter((run) => run && Array.isArray(run.curve) && run.curve.length > 1);
    const unit = s.powerUnit || 'hp', torqueUnit = s.torqueUnit || 'nm';
    const xMin = 1000;
    const maxPointRpm = curves.reduce((max, run) => Math.max(max, run.curve[run.curve.length - 1].rpm), 0);
    const configuredMax = Number(s.graphMaxRpm);
    // Leave breathing room after a pull. The old automatic scale ended at the
    // final 1,000-rpm tick, pinning the curve to the right edge.
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
    const x = 144, y = 184, w = 730, h = 222;
    const X = (rpm) => x + (clamp(rpm, xMin, xMax) - xMin) / (xMax - xMin) * w;
    const YP = (value) => y + h - clamp(powerValue(value, unit) / powerMax, 0, 1) * h;
    const YT = (value) => y + h - clamp(value * torqueFactor(torqueUnit) / torqueMax, 0, 1) * h;

    // Separate the plotted data from the surrounding panel and its grid.
    cv.roundRect(x - 1, y - 1, w + 2, h + 2, 5, '#0A0F17');
    cv.strokeRoundRect(x - 1, y - 1, w + 2, h + 2, 5, 1, G.withAlpha('#A9B8CC', 0.16));

    // Match DYNO's six clear scale marks (five equal intervals). Four intervals
    // produced awkward torque labels such as 188 / 375 / 563.
    for (let i = 0; i <= 5; i++) {
        const fraction = i / 5;
        const yy = y + h * fraction;
        cv.fillRect(x, yy, w, 1, G.withAlpha(t.tick, i === 5 ? 0.5 : 0.24));
        cv.fillRect(x - 5, yy, 5, 1.5, G.withAlpha(POWER, 0.8));
        cv.fillRect(x + w, yy, 5, 1.5, G.withAlpha(TORQUE, 0.82));
        cv.text(String(Math.round(powerMax * (1 - fraction))), x - 12, yy + 5, 15, POWER, { align: 'right', font: 'bold' });
        cv.text(number(torqueMax * (1 - fraction), torqueDigits(torqueUnit)), x + w + 12, yy + 5, 15, G.withAlpha(TORQUE, 0.96), { font: 'bold' });
    }
    // Every 1,000 rpm, with both ends of the displayed range labelled.
    const rpmTicks = [];
    for (let rpm = xMin; rpm <= xMax; rpm += 1000) rpmTicks.push(rpm);
    if (rpmTicks[rpmTicks.length - 1] < xMax) rpmTicks.push(xMax);
    rpmTicks.forEach((rpm, index) => {
        const xx = X(rpm);
        cv.fillRect(xx, y, 1, h, G.withAlpha(t.tick, index === 0 || rpm === xMax ? 0.3 : 0.18));
        cv.fillRect(xx, y + h, 1.5, 5, G.withAlpha(t.dim, 0.75));
        const rpmLabel = rpm % 1000 === 0 ? String(rpm / 1000) : number(rpm / 1000, 1);
        cv.text(rpmLabel, xx, y + h + 20, 15, t.dim, { align: 'center', font: 'bold' });
    });
    cv.text(powerName(unit).toUpperCase(), x - 12, y - 12, 12, POWER, { align: 'right', font: 'bold' });
    cv.text(torqueName(torqueUnit).toUpperCase(), x + w + 12, y - 12, 12, TORQUE, { font: 'bold' });
    cv.text('x1000 RPM', x + w / 2, y + h + 42, 13, t.dim, { align: 'center', font: 'bold', spacing: 0.8 });
    cv.fillRect(x, y + h, w, 2, G.withAlpha('#ffffff', 0.68));
    if (!curves.length) {
        cv.text(s.pullStatus === 'recording' ? 'RECORDING ROAD PULL' : 'NO DYNO RUN RECORDED', x + w / 2, y + 100, 22, t.dim,
            { align: 'center', font: 'bold', spacing: 1.1 });
        cv.text(s.pullStatus === 'recording' ? 'Keep one gear steady through the pull' : 'Hold one gear · flat road · full throttle · 1,500 rpm sweep',
            x + w / 2, y + 130, 14, t.dim, { align: 'center' });
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
            const first = [X(from), mapY(atRpm(from))], last = [X(to), mapY(atRpm(to))];
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
            const peak = [X(current.peakPrpm), YP(current.peakP)];
            cv.circle(peak[0], peak[1], 8, G.withAlpha('#071019', 0.94));
            cv.circle(peak[0], peak[1], 6, G.withAlpha('#FFFFFF', 0.96));
            cv.circle(peak[0], peak[1], 3.5, POWER);
        }
        if (tPoints.length && current.peakTrpm >= xMin && current.peakTrpm <= xMax) {
            const peak = [X(current.peakTrpm), YT(current.peakT)];
            cv.circle(peak[0], peak[1], 7, G.withAlpha('#071019', 0.94));
            cv.circle(peak[0], peak[1], 5, G.withAlpha('#FFFFFF', 0.92));
            cv.circle(peak[0], peak[1], 3, TORQUE);
        }
    }
}

function drawLegend(cv, G, t, current, ecuTorque) {
    const items = [[POWER, 'POWER'], [TORQUE, 'ROAD TORQUE']];
    if (ecuTorque && current && current.curve.some((point) => typeof point.ecuTorqueNm === 'number')) items.push([G.withAlpha(ECU_TORQUE, 0.64), 'ECU TORQUE']);
    let x = 48;
    items.forEach(([color, label]) => {
        cv.roundRect(x, 153, 18, 5, 2, color);
        cv.text(label, x + 25, 160, 12, t.dim, { font: 'bold', spacing: 0.5 });
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

function drawResultCard(cv, G, t, x, y, w, label, value, unit, detail, color) {
    cv.roundRect(x, y, w, 122, 7, G.withAlpha('#000000', 0.28));
    cv.strokeRoundRect(x, y, w, 122, 7, 1, G.withAlpha(color, 0.3));
    cv.text(label, x + 11, y + 22, 10, t.dim, { font: 'bold', spacing: 0.5 });
    const valueText = number(value, 0);
    cv.text(valueText, x + 11, y + 68, 31, color, { font: 'num' });
    cv.text(unit, x + 17 + cv.textWidth(valueText, 31, { font: 'num' }), y + 68, 12, t.dim);
    cv.text(detail, x + 11, y + 96, 9, t.dim, { font: 'bold', spacing: 0.25 });
}

function drawSheet(cv, G, t, s, car, current) {
    G.panel(cv, t, 24, 92, 984, 398, 'ROAD DYNO STATS');
    drawLegend(cv, G, t, current, s.ecuTorque);
    chart(cv, G, t, s, current);

    const isPull = s.pullStatus === 'recording';
    G.panel(cv, t, 1024, 92, 552, 398, 'DYNO RESULTS');
    const stateLabel = isPull ? 'LIVE' : current ? 'LAST RUN' : 'STANDBY';
    const stateColor = isPull ? RED : current ? TORQUE : t.dim;
    cv.roundRect(1430, 103, 122, 24, 12, G.withAlpha(stateColor, 0.16));
    cv.text(stateLabel, 1491, 119, 10, stateColor, { align: 'center', font: 'bold', spacing: 1.1 });
    if (isPull) cv.circle(1538, 123, 6, Math.floor(Date.now() / 300) % 2 ? RED : G.withAlpha(RED, 0.3));

    const loss = current ? current.loss : (typeof s.loss === 'number' ? s.loss : 15);
    const enginePowerW = isPull ? (s.livePowerW || 0) : current ? current.peakP : 0;
    const torqueNm = isPull ? (s.liveTorqueNm || 0) : current ? current.peakT : 0;
    const powerRpm = isPull ? (s.rpm || 0) : current ? current.peakPrpm : 0;
    const torqueRpm = isPull ? (s.rpm || 0) : current ? current.peakTrpm : 0;
    const power = powerValue(enginePowerW, s.powerUnit);
    const torque = torqueNm * torqueFactor(s.torqueUnit);
    const wheelPower = powerValue(enginePowerW * (1 - loss / 100), s.powerUnit);
    const powerUnit = powerName(s.powerUnit);
    const torqueUnit = torqueName(s.torqueUnit);
    const detailPower = isPull ? 'LIVE ROAD ESTIMATE' : current ? '@ ' + number(powerRpm, 0) + ' RPM' : 'NO RUN RECORDED';
    const detailTorque = isPull ? 'LIVE ENGINE SIGNAL' : current ? '@ ' + number(torqueRpm, 0) + ' RPM' : 'NO RUN RECORDED';
    const detailWheels = current || isPull ? number(loss, 0) + '% LOSS ESTIMATE' : 'NO RUN RECORDED';
    drawResultCard(cv, G, t, 1048, 140, 160, 'ENGINE POWER', power, powerUnit, detailPower, POWER);
    drawResultCard(cv, G, t, 1220, 140, 160, 'TORQUE', torque, torqueUnit, detailTorque, TORQUE);
    drawResultCard(cv, G, t, 1392, 140, 160, 'WHEELS POWER', wheelPower, powerUnit, detailWheels, POWER);
    cv.fillRect(1048, 278, 504, 1, G.withAlpha(t.tick, 0.3));
    drawCar(cv, G, t, car, { x: 1048, y: 286, w: 528, h: 186 });
}

function draw(cv, G, t, s, car, actions) {
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'RACE MODES'], 2, [
        s.demo && { text: 'DEMO · NO ROAD DATA', color: 'crit' },
    ]);
    G.sectionRule(cv, t, 24, G.TOP || 44, W - 48, RED);
    drawSheet(cv, G, t, s, car, selectedRun(s));
    return cv;
}

module.exports = { W, H, draw, selectedRun, contain, powerValue, torqueFactor };
