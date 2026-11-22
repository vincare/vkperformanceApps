'use strict';

const DragRun = require('./drag_run');
const W = 1600, H = 520;
const RED = '#f32635';
const GREEN = '#36d889';

function number(value, digits) {
    if (typeof value !== 'number' || !isFinite(value)) return '--';
    const scale = Math.pow(10, digits || 0);
    return String(Math.round(value * scale) / scale);
}

function contain(rect, width, height) {
    if (!(width > 0) || !(height > 0)) return rect;
    const scale = Math.min(rect.w / width, rect.h / height);
    const w = width * scale, h = height * scale;
    return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

function button(cv, G, t, x, y, w, h, label, fn, primary, enabled) {
    const disabled = enabled === false;
    const fill = primary ? G.withAlpha(RED, 0.86) : G.withAlpha('#ffffff', disabled ? 0.02 : 0.045);
    const edge = primary ? RED : G.withAlpha('#ffffff', disabled ? 0.1 : 0.24);
    cv.roundRect(x, y, w, h, 7, fill);
    cv.strokeRoundRect(x, y, w, h, 7, 1.4, edge);
    cv.text(label, x + w / 2, y + h / 2 + 5, 13, disabled ? t.dim : t.text,
        { align: 'center', font: 'bold', spacing: 0.8 });
    if (cv.own && fn && !disabled) cv.target(x, y, w, h, fn, 'performance_drag_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
}

function valueTile(cv, G, t, x, y, w, h, label, time, best, color) {
    const accent = color || RED;
    cv.roundRect(x, y, w, h, 7, G.withAlpha('#ffffff', 0.045));
    cv.strokeRoundRect(x, y, w, h, 7, 1, G.withAlpha(accent, 0.3));
    cv.fillRect(x + 1, y + 10, 3, h - 20, G.withAlpha(accent, 0.85));
    cv.text(label, x + 12, y + 19, 10, t.dim, { font: 'bold', spacing: 0.55 });
    cv.text(time, x + 12, y + h - 10, 22, time === '--.--' ? t.dim : accent, { font: 'num' });
    if (best) cv.text('BEST ' + best, x + w - 8, y + h - 10, 9, GREEN, { align: 'right', font: 'bold' });
}

function drawCar(cv, t, car, rect) {
    if (!car || !car.imageId || !(car.width > 0) || !(car.height > 0)) {
        cv.text('SIDE VIEW UNAVAILABLE', rect.x + rect.w / 2, rect.y + rect.h / 2, 13, t.dim, { align: 'center', font: 'bold' });
        return;
    }
    const image = contain(rect, car.width, car.height);
    cv.image(car.imageId, image.x, image.y, image.w, image.h);
}

function sectionTitle(cv, G, t, x, y, w, label) {
    cv.fillRect(x, y, w, 1, G.withAlpha(t.panelEdge, 0.9));
    cv.fillRect(x, y, 76, 4, t.accent);
    cv.text(label, x + 16, y + 32, 16, t.text, { font: 'bold', spacing: 1.4 });
}

function drawTrace(cv, G, t, s, trace) {
    const x = 576, y = 184, w = 418, h = 220;
    const unit = s.speedUnit || 'kmh';
    const factor = unit === 'mph' ? 1 / 1.609344 : 1;
    const points = DragRun.compactTrace(trace, DragRun.MAX_TRACE_POINTS);
    const tMax = Math.max(8, Math.ceil((points.length ? points[points.length - 1][0] : 0) / 2) * 2);
    const maxSpeed = points.reduce((max, point) => Math.max(max, point[1] * factor), 0);
    const vMax = Math.max(unit === 'mph' ? 100 : 160, Math.ceil((maxSpeed + 10) / 40) * 40);
    const X = (sec) => x + Math.max(0, Math.min(tMax, sec)) / tMax * w;
    const Y = (speed) => y + h - Math.max(0, Math.min(vMax, speed * factor)) / vMax * h;
    for (let i = 0; i <= 4; i++) {
        const yy = y + i * h / 4;
        cv.fillRect(x, yy, w, 1, G.withAlpha(t.tick, i === 4 ? 0.5 : 0.27));
        cv.text(String(Math.round(vMax * (1 - i / 4))), x - 10, yy + 6, 12, t.dim, { align: 'right' });
    }
    const step = tMax > 20 ? 5 : 2;
    for (let sec = 0; sec <= tMax; sec += step) {
        const xx = X(sec);
        cv.fillRect(xx, y, 1, h, G.withAlpha(t.tick, 0.16));
        cv.text(sec + 's', xx, y + h + 18, 11, t.dim, { align: 'center' });
    }
    cv.text(unit === 'mph' ? 'MPH' : 'KM/H', x - 10, y - 10, 11, t.dim, { align: 'right', font: 'bold' });
    cv.text('TIME · SECONDS', x + w / 2, y + h + 34, 11, t.dim, { align: 'center', font: 'bold', spacing: 1 });
    if (points.length > 1) {
        const line = points.map((point) => [X(point[0]), Y(point[1])]);
        cv.fillUnder(line, y + h, G.withAlpha(RED, 0.12));
        cv.polyline(line, 3.2, RED);
        const last = line[line.length - 1];
        cv.circle(last[0], last[1], 6, t.text);
        cv.circle(last[0], last[1], 3, RED);
    } else {
        cv.text(s.timerState === 'ready' ? 'LAUNCH WHEN READY' : 'WAITING FOR ACCELERATION', x + w / 2, y + h / 2 + 5,
            14, t.dim, { align: 'center', font: 'bold', spacing: 1.1 });
    }
}

function drawLive(cv, G, t, s, car, actions) {
    const speedUnit = s.speedUnit || 'kmh';
    const current = s.currentRun || {};
    const splits = s.splits || [];
    G.panel(cv, t, 24, 92, 480, 398, 'LAUNCH CONTROL');
    G.panel(cv, t, 520, 92, 530, 398, 'ACCELERATION TRACE');
    sectionTitle(cv, G, t, 1066, 92, 510, 'SELECTED BMW');

    const stateLabel = s.demo ? 'DEMO · TIMER PAUSED' : s.speed === null && s.timerState !== 'run' ? 'WAITING FOR SPEED' :
        s.timerState === 'run' ? 'TIMING' :
        s.timerState === 'ready' ? 'READY · LAUNCH' : 'STOP TO ARM';
    const stateColor = s.timerState === 'run' ? RED : s.timerState === 'ready' ? GREEN : t.dim;
    cv.roundRect(298, 105, 178, 25, 12, G.withAlpha(stateColor, 0.14));
    cv.strokeRoundRect(298, 105, 178, 25, 12, 1, G.withAlpha(stateColor, 0.28));
    cv.circle(312, 117, 4, stateColor);
    cv.text(stateLabel, 324, 121, 10, stateColor, { font: 'bold', spacing: 0.7 });
    button(cv, G, t, 338, 140, 142, 30, 'RESET TIMER', actions.reset, false, !s.demo);

    cv.roundRect(48, 178, 205, 100, 7, G.withAlpha('#000000', 0.24));
    cv.roundRect(267, 178, 213, 100, 7, G.withAlpha('#000000', 0.24));
    cv.strokeRoundRect(48, 178, 205, 100, 7, 1, G.withAlpha(t.text, 0.1));
    cv.strokeRoundRect(267, 178, 213, 100, 7, 1, G.withAlpha(RED, 0.22));
    cv.fillRect(49, 189, 3, 78, G.withAlpha(t.accent, 0.75));
    cv.fillRect(268, 189, 3, 78, G.withAlpha(RED, 0.78));
    cv.text('VEHICLE SPEED', 63, 202, 11, t.dim, { font: 'bold', spacing: 1.2 });
    const speed = typeof s.speed === 'number' ? DragRunSpeed(s.speed, speedUnit) : null;
    const speedText = speed === null ? '0' : number(speed, 0);
    cv.text(speedText, 63, 261, 54, speed === null ? t.dim : t.text, { font: 'num' });
    const speedX = 68 + cv.textWidth(speedText, 54, { font: 'num' });
    cv.text(speedUnit === 'mph' ? 'MPH' : 'KM/H', speedX, 258, 13, t.dim, { font: 'bold' });
    cv.text('ELAPSED TIME', 282, 202, 11, t.dim, { font: 'bold', spacing: 1.2 });
    const elapsed = s.timerState === 'run' ? s.elapsed : current.elapsed;
    const elapsedText = typeof elapsed === 'number' ? elapsed.toFixed(2) : '0.00';
    cv.text(elapsedText, 282, 253, 34,
        s.timerState === 'run' ? t.text : elapsed ? RED : t.dim, { font: 'num' });
    cv.text('s', 286 + cv.textWidth(elapsedText, 34, { font: 'num' }), 251, 13, t.dim, { font: 'bold' });
    cv.fillRect(48, 289, 432, 1, G.withAlpha(t.tick, 0.3));
    const peakG = s.timerState === 'run' ? s.peakG : current.peakG;
    const vmax = s.timerState === 'run' ? s.vmax : current.vmax;
    cv.text('PEAK G', 50, 312, 10, t.dim, { font: 'bold', spacing: 0.8 });
    cv.text(number(peakG || 0, 2) + ' g', 50, 341, 20, t.text, { font: 'bold' });
    cv.text('MAX SPEED', 264, 312, 10, t.dim, { font: 'bold', spacing: 0.8 });
    cv.text(number(vmax ? DragRunSpeed(vmax, speedUnit) : 0, 0) + ' ' + (speedUnit === 'mph' ? 'MPH' : 'KM/H'),
        264, 341, 18, t.text, { font: 'bold' });

    const bestMap = s.best || {};
    const topY = 355, secondY = 420, tileH = 56;
    const topW = 136, gap = 8, left = 48;
    splits.slice(0, 3).forEach((split, i) => {
        const value = current.result && current.result[split.key];
        const best = bestMap[DragRunBestKey(split.key, speedUnit, !!s.rollout)];
        valueTile(cv, G, t, left + i * (topW + gap), topY, topW, tileH, split.label,
            DragRunSeconds(value), best && DragRunSeconds(best.s), split.dist ? '#f3b548' : RED);
    });
    const lowerW = 208, lowerGap = 16, lowerLeft = 72;
    splits.slice(3).forEach((split, i) => {
        const value = current.result && current.result[split.key];
        const best = bestMap[DragRunBestKey(split.key, speedUnit, !!s.rollout)];
        valueTile(cv, G, t, lowerLeft + i * (lowerW + lowerGap), secondY, lowerW, tileH, split.label,
            DragRunSeconds(value), best && DragRunSeconds(best.s), split.dist ? '#f3b548' : RED);
    });

    drawTrace(cv, G, t, s, s.timerState === 'run' ? s.trace : current.trace);
    const modelLabel = car && car.model ? car.model.label : 'BMW';
    cv.text(modelLabel, 1092, 149, 11, t.dim, { font: 'bold', spacing: 1 });
    drawCar(cv, t, car, { x: 1082, y: 154, w: 478, h: 159 });
    G.panel(cv, t, 1066, 320, 510, 170, 'DISTANCE RESULT');
    const distance = splits.find((split) => split.dist);
    const distanceTime = distance && current.result && current.result[distance.key];
    const distanceTrap = distance && current.trap && current.trap[distance.key];
    cv.roundRect(1092, 374, 166, 76, 7, G.withAlpha('#000000', 0.22));
    cv.roundRect(1272, 374, 266, 76, 7, G.withAlpha('#000000', 0.22));
    cv.strokeRoundRect(1092, 374, 166, 76, 7, 1, G.withAlpha('#f3b548', 0.25));
    cv.strokeRoundRect(1272, 374, 266, 76, 7, 1, G.withAlpha(t.text, 0.1));
    cv.text(distance ? distance.label : 'DISTANCE', 1106, 391, 10, t.dim, { font: 'bold', spacing: 0.8 });
    const distanceTimeText = DragRunSeconds(distanceTime);
    cv.text(distanceTimeText, 1106, 431, 31, distanceTime ? '#f3b548' : t.dim, { font: 'num' });
    cv.text('s', 1110 + cv.textWidth(distanceTimeText, 31, { font: 'num' }), 429, 13, t.dim, { font: 'bold' });
    cv.text('TRAP SPEED', 1288, 391, 10, t.dim, { font: 'bold', spacing: 0.8 });
    cv.text((distanceTrap ? number(DragRunSpeed(distanceTrap, speedUnit), 0) : '0') + ' ' + (speedUnit === 'mph' ? 'MPH' : 'KM/H'),
        1288, 428, 20, t.text, { font: 'bold' });
    const spin = s.timerState === 'run' ? s.wheelspin : current.wheelspin;
    cv.text(spin ? 'WHEELSPIN EST.  ' + spin.peak + '%  ·  ' + number(spin.seconds, 1) + ' s' : 'WHEELSPIN EST.  --',
        1094, 463, 12, spin ? '#f3b548' : t.dim, { font: 'bold', spacing: 0.35 });

}

function drawHistory(cv, G, t, s, car, actions) {
    const unit = s.speedUnit || 'kmh';
    const runs = s.runs || [];
    const visibleRuns = runs.filter((run) => (run.unit || 'kmh') === unit);
    const pageSize = 6, start = s.listOffset || 0;
    const shown = visibleRuns.slice(start, start + pageSize);
    const selected = visibleRuns.find((run) => run.at === s.selectedAt) || visibleRuns[0] || null;
    G.panel(cv, t, 24, 92, 460, 398, 'PERSONAL BESTS');
    G.panel(cv, t, 500, 92, 570, 398, 'RECENT RUNS');
    sectionTitle(cv, G, t, 1086, 92, 490, 'SELECTED RUN');

    (s.splits || []).forEach((split, i) => {
        const y = 161 + i * 57;
        const key = DragRunBestKey(split.key, unit, !!s.rollout);
        const best = s.best && s.best[key];
        cv.text(split.label, 50, y, 13, t.dim, { font: 'bold', spacing: 0.4 });
        cv.text(best ? DragRunSeconds(best.s) : '--.--', 458, y + 5, 27, best ? (split.dist ? '#f3b548' : RED) : t.dim,
            { align: 'right', font: 'num' });
        cv.text('s', 465, y + 20, 10, t.dim);
        if (best && best.trap) cv.text('@ ' + number(DragRunSpeed(best.trap, unit), 0) + ' ' + unit.toUpperCase(), 50, y + 21, 10, t.dim);
        if (i < (s.splits || []).length - 1) cv.fillRect(50, y + 30, 414, 1, G.withAlpha(t.tick, 0.22));
    });

    cv.text('DATE / TIME', 523, 153, 10, t.dim, { font: 'bold', spacing: 0.55 });
    cv.text(unit === 'mph' ? '0–60 MPH' : '0–100 KM/H', 708, 153, 10, t.dim, { font: 'bold', spacing: 0.4 });
    cv.text(s.distanceLabel || 'DISTANCE', 842, 153, 10, t.dim, { font: 'bold', spacing: 0.4 });
    cv.text('TRAP', 985, 153, 10, t.dim, { font: 'bold', spacing: 0.4 });
    shown.forEach((run, i) => {
        const y = 190 + i * 35;
        const date = new Date(run.at);
        const pad = (v) => String(v).padStart(2, '0');
        const selectedRow = selected && selected.at === run.at;
        if (selectedRow) cv.roundRect(514, y - 19, 542, 29, 3, G.withAlpha(RED, 0.16));
        const firstKey = unit === 'mph' ? '0-60mph' : '0-100';
        const distanceKey = run.distanceKey || 'qm';
        const distanceLabel = run.distanceLabel || '1/4 MILE';
        const bestSpeed = run.result && run.result[firstKey];
        const distanceTime = run.result && run.result[distanceKey];
        const trap = run.trap && run.trap[distanceKey];
        cv.text(pad(date.getDate()) + '.' + pad(date.getMonth() + 1) + '  ' + pad(date.getHours()) + ':' + pad(date.getMinutes()),
            523, y, 12, t.text);
        cv.text(DragRunSeconds(bestSpeed), 750, y, 13, bestSpeed ? RED : t.dim, { font: 'num' });
        cv.text(DragRunSeconds(distanceTime), 882, y, 13, distanceTime ? '#f3b548' : t.dim, { font: 'num' });
        cv.text(trap ? number(DragRunSpeed(trap, unit), 0) : '--', 985, y, 13, t.dim, { font: 'num' });
        if (cv.own && actions.select) cv.target(514, y - 20, 542, 31, () => actions.select(run.at), 'performance_drag_run_' + i);
    });
    if (!shown.length) cv.text('NO RUNS SAVED YET', 785, 267, 17, t.dim, { align: 'center', font: 'bold', spacing: 1 });
    button(cv, G, t, 520, 444, 142, 28, 'PREVIOUS', actions.prevList, false, start > 0);
    button(cv, G, t, 674, 444, 142, 28, 'NEXT RUNS', actions.nextList, false, start + pageSize < visibleRuns.length);
    cv.text(shown.length ? (start + 1) + '–' + (start + shown.length) + ' / ' + visibleRuns.length : '0 / 0',
        830, 481, 10, t.dim, { align: 'center', font: 'bold' });

    const modelLabel = car && car.model ? car.model.label : 'BMW';
    cv.text(modelLabel, 1110, 149, 10, t.dim, { font: 'bold', spacing: 0.8 });
    drawCar(cv, t, car, { x: 1102, y: 154, w: 458, h: 138 });
    G.panel(cv, t, 1086, 300, 490, 190, 'RUN DETAILS');
    if (selected) {
        const firstKey = unit === 'mph' ? '0-60mph' : '0-100';
        const time = selected.result && selected.result[firstKey];
        cv.text(unit === 'mph' ? '0–60 MPH' : '0–100 KM/H', 1110, 360, 10, t.dim, { font: 'bold' });
        cv.text(DragRunSeconds(time) + ' s', 1110, 391, 22, time ? RED : t.dim, { font: 'num' });
        cv.text('PEAK G  ' + number(selected.peakG || 0, 2) + ' g', 1360, 360, 11, t.dim, { font: 'bold' });
        const spin = selected.wheelspin;
        cv.text(spin ? 'WHEELSPIN EST.  ' + spin.peak + '%' : 'WHEELSPIN EST.  --', 1110, 421, 11,
            spin ? '#f3b548' : t.dim, { font: 'bold' });
    } else {
        cv.text('NO SAVED RUN SELECTED', 1330, 385, 12, t.dim, { align: 'center', font: 'bold' });
    }
    button(cv, G, t, 1110, 444, 170, 28, 'LIVE RUN', actions.live, false);
    button(cv, G, t, 1292, 444, 250, 28, s.clearArmed ? 'CONFIRM CLEAR' : 'CLEAR RUNS', actions.clear,
        !!s.clearArmed, runs.length > 0 || !!s.clearArmed);
}

function DragRunSpeed(kmh, unit) { return DragRun.speedValue(kmh, unit); }
function DragRunBestKey(key, unit, rollout) { return DragRun.bestKey(key, unit, rollout); }
function DragRunSeconds(value) { return DragRun.seconds(value); }

function draw(cv, G, t, s, car, actions) {
    G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'RACE MODES'], 2, [
        s.demo && { text: 'DEMO · TIMING DISABLED', color: 'crit' },
    ]);
    button(cv, G, t, 24, 50, 174, 34, s.view === 'history' ? 'LIVE RUN' : 'RUN HISTORY', actions.toggleView, s.view === 'history',
        s.view !== 'history' || (s.runs && s.runs.length > 0));
    if (s.view === 'history') drawHistory(cv, G, t, s, car, actions);
    else drawLive(cv, G, t, s, car, actions);
    return cv;
}

module.exports = { W, H, draw, contain, drawTrace };
