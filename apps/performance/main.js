'use strict';

/**
 * Performance - live engine monitor and guarded exhaust-flap page for MGU / iDrive 7.
 *
 * Performance values use the same BMW signals, scaling, and source selection
 * as M Vitals. The Sport Display reports power as a percentage, so its HP/kW
 * readout is that percentage times the configured vehicle maximum. Torque ×
 * RPM is the fallback when the Sport Display percentage is unavailable.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Calc = require('./calculations');
const Dyno = require('./dyno');
const { RunTimer } = require('./kit/run_timer');
const DragRun = require('./drag_run');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const FlapUi = require('./flap_ui');
const CarImages = require('./car_images');
const DynoUi = require('./dyno_ui');
const DragRunUi = require('./drag_run_ui');
const RaceModesUi = require('./race_modes_ui');
const CarDataUi = require('./car_data_ui');
const WarmupUi = require('./warmup_ui');
const MisfireTrack = require('./misfire_track');
const TyreData = require('./tyre_data');
const { Warmup } = require('./warmup');
const { Controller: FlapController } = require('./flap_controller');
const { AutoFlap, flapFor, modeName } = require('./flap_auto');
const fs = require('fs');
const path = require('path');

const W = 1600, H = 520;
const PAGE_TEXT_SCALE = 1.3;
const FRESH_MS = 4500;
const DYNO_FRESH_MS = 500;
// Keep non-dashboard pages light; the main Engine Data page gets a smoother 20 Hz update.
const RENDER_MS = 100;
const ENGINE_DATA_FPS = 20;
const ENGINE_DATA_RENDER_MS = 1000 / ENGINE_DATA_FPS;
const DME_POLL_MS = 1200;
const PEAK_HOLD_MS = 15000;
const CD_STALE = 120000;
const GEARBOX_STALE_MS = 45000;
const RPM_MAX = 8000;
const BOOST_MAX_BAR = 2.5;
const PRESSURE_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI', BAR: 'BAR', KPA: 'KPA', PSI: 'PSI' };
const DRIVE_STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
const GEAR_NAMES = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10 };

function finite(value) { return typeof value === 'number' && isFinite(value); }
function metricStaleMs(name) { return name === 'gearboxTemp' ? GEARBOX_STALE_MS : CD_STALE; }
function json(value) {
    try { return JSON.stringify(value); } catch (e) { return '[unserializable]'; }
}
function pressureUnit(value) {
    const raw = value && typeof value === 'object' ? (value.name || value.value) : value;
    if (typeof raw === 'string') return PRESSURE_UNITS[raw.trim().toUpperCase()] || null;
    return PRESSURE_UNITS[raw] || null;
}
function gearNumber(value) {
    if (typeof value === 'number') return value >= 3 && value <= 12 ? value - 2 : value === 1 ? -1 : value === 2 ? 0 : null;
    const text = String(value || '').toUpperCase();
    return GEAR_NAMES[text] === undefined ? null : GEAR_NAMES[text];
}
function selectedGearLabel(value) {
    let n = typeof value === 'number' ? value : ({ N: 1, R: 2, P: 3, NP: 4 })[String(value || '').toUpperCase()];
    if (n === undefined) {
        const match = /^_(\d)$/.exec(String(value || '').toUpperCase());
        if (match) n = 4 + Number(match[1]);
    }
    if (n === 1) return 'N';
    if (n === 2) return 'R';
    if (n === 3) return 'P';
    if (n === 4) return 'N/P';
    if (n >= 5 && n <= 13) return 'D' + (n - 4);
    return null;
}
function metric() { return { raw: null, value: null, unit: '', source: '', at: 0, status: 'waiting' }; }
function fresh(m, now) { return !!(m && m.at && now - m.at <= FRESH_MS && m.status === 'live' && finite(m.value)); }
function formatNumber(value, decimals) {
    if (!finite(value)) return '--';
    const p = Math.pow(10, decimals || 0);
    return String(Math.round(value * p) / p);
}
function shortError(error) { return String(error && error.message || error || 'unknown').replace(/[\r\n]+/g, ' '); }

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        FlapUi.setArtCacheDir(ctx.dataDir, ctx.spec && ctx.spec.version);
        const diagnostics = () => settings.get('performanceDiagnostics') === true;
        const config = ctx.spec && ctx.spec.config || {};
        const scaling = config.scaling || {};
        const dme = Object.assign({ ecu: 0x12, boost: [], baro: [] }, config.dme || {});
        const dynoFile = path.join(ctx.dataDir, 'performance_dyno_runs.json');
        const dragRunFile = path.join(ctx.dataDir, 'performance_drag_runs.json');
        let dynoRuns = [], dynoBaselineAt = null, dynoSelectedAt = null;
        let dynoView = 'sheet', dynoDisplayCleared = false;
        try {
            const saved = JSON.parse(fs.readFileSync(dynoFile, 'utf8'));
            if (saved && Array.isArray(saved.runs)) dynoRuns = saved.runs.filter((run) =>
                run && finite(run.at) && finite(run.peakP) && finite(run.peakT) && finite(run.peakPrpm) && finite(run.peakTrpm) &&
                Array.isArray(run.curve) && run.curve.length > 1 && run.curve.every((point) =>
                    point && finite(point.rpm) && finite(point.powerW) && finite(point.torqueNm)))
                .sort((a, b) => b.at - a.at).slice(0, 20);
            if (saved && finite(saved.baselineAt)) dynoBaselineAt = saved.baselineAt;
        } catch (e) { /* first start */ }
        let dragRuns = [], dragBest = Object.create(null), dragSelectedAt = null;
        let dragView = 'live', dragListOffset = 0, dragClearUntil = 0, dragPeakG = 0;
        let dragLiveCleared = false;
        let rollingTimer = null, rollingResult = {}, demoRollingCleared = false;
        // Dragy-style road grade: accelerometer holds gravity, so slope% =
        // (a_measured - dv/dt) / g. At a standstill dv/dt is 0 and the raw
        // accelerometer offset is the grade directly.
        let slopePct = null, slopeAt = 0, accelMps2 = null, accelAt = 0;
        const slopeSpeeds = [];   // {t, v} km/h samples for dv/dt
        let dragPulse = null, lastDragState = 'wait', mainLoop = null;
        try {
            const saved = JSON.parse(fs.readFileSync(dragRunFile, 'utf8'));
            if (saved && Array.isArray(saved.runs)) dragRuns = saved.runs.filter((run) =>
                run && finite(run.at) && run.result && typeof run.result === 'object' &&
                Array.isArray(run.trace) && run.trace.every((point) => Array.isArray(point) && finite(point[0]) && finite(point[1])))
                .map((run) => Object.assign({}, run, { trace: DragRun.compactTrace(run.trace) }))
                .sort((a, b) => b.at - a.at).slice(0, 30);
            if (saved && saved.best && typeof saved.best === 'object') dragBest = saved.best;
            if (saved && finite(saved.selectedAt)) dragSelectedAt = saved.selectedAt;
        } catch (e) { /* first start */ }
        const dynoRecorder = new Dyno.Recorder();
        const dragWheelspin = new DragRun.WheelspinEstimate();
        let dragTimer;
        const state = {
            providers: Object.create(null),
            rpm: metric(), torqueFes: metric(), speed: metric(), gLong: metric(),
            powerPct: metric(), torquePct: metric(),
            boostFes: metric(), boostDme: metric(), pressureUnit: null,
            baroKpa: 101.3, baroMeasured: false, baroAt: 0,
            stopped: false, dmeBusy: false, dmeReady: false,
        };
        let firstFesBoost = null, fesBoostTrusted = false;
        let firstDmeBoost = null, dmeBoostTrusted = false;
        // WARMUP page: warm-up ETAs, safe rev limit, turbo cool-down and cold starts.
        // Fed from updateMetric below so the history fills on every page, not just WARMUP.
        const warmup = new Warmup({
            settings,
            redline: () => settings.get('warmupRedline') || 7000,
            coldRpm: () => settings.get('warmupColdLimit') || 3500,
        });
        const peaks = { live: Object.create(null), demo: Object.create(null) };
        const subscriptions = [];
        const diagnosticDedup = Object.create(null);
        let renderTimer = null, renderQueued = false, renderInFlight = null;
        let renderDirty = true, lastRenderAt = 0;
        let freshnessTimer = null, dmeTimer = null, demoTimer = null, carDataArtTimer = null;
        let carDataArtIndex = 0, carDataArtBg = null;
        let link = null, reader = null, dmeInit = null;
        let lastDynoGate = null;
        let vehicleGear = null, vehicleGearAt = 0;
        const cachedDriveMode = settings.get('lastDriveMode');
        let page = 0, engineConfigView = 'sections', carDataView = 'menu', tyrePage = 'main', valveReady = false;
        let drivingMode = flapFor(cachedDriveMode) ? cachedDriveMode : null;
        let driveModeConfirmed = false;
        let burbleTarget = 1.5, burbleCommandActive = false;
        let driveModeLoading = false, driveModePollStarting = false, driveModePollSub = null, driveModePollTimer = null;
        let valveRescanTimer = null, smokeTick = null;
        let valveNoticeTimer = null, valveActionNotice = '', valveActionNoticeUntil = 0;
        let valveScanBusy = false, valveScanTries = 0, valveScanAt = 0, bm3ScanRetryCount = 0;
        let carVisual = null, carVisualKey = '', carSideVisual = null, carSideVisualKey = '';
        let mSoundEnabled = false;
        let mSoundBusy = false;
        let demoSelectedMode = null;
        let valveCommandActive = false, valvePriorityUntil = 0;

        function selectedCarVisual(theme) {
            const selected = CarImages.model(settings.get('carModel'));
            const key = selected.key + '|' + theme.bg;
            if (carVisualKey === key) return carVisual;
            carVisualKey = key;
            carVisual = null;
            try {
                carVisual = CarImages.load(selected.key, theme.bg);
                log.info('Car Model loaded: ' + selected.file + ' (' + carVisual.width + 'x' + carVisual.height + ')');
            } catch (e) {
                log.warn('Car Model image: ' + shortError(e));
            }
            return carVisual;
        }

        function selectedCarSideVisual(theme) {
            const selected = CarImages.model(settings.get('carModel'));
            const key = selected.key + '|' + theme.bg;
            if (carSideVisualKey === key) return carSideVisual;
            carSideVisualKey = key;
            carSideVisual = null;
            try {
                carSideVisual = CarImages.loadSide(selected.key, theme.bg);
                log.info('Car side view loaded: ' + carSideVisual.sourceFile + ' (' + carSideVisual.width + 'x' + carSideVisual.height + ')');
            } catch (e) {
                log.warn('Car side view image: ' + shortError(e));
            }
            return carSideVisual;
        }

        function saveDynoRuns() {
            const runs = dynoRuns.filter((run) => !run.demo);
            try { fs.writeFileSync(dynoFile, JSON.stringify({ runs,
                baselineAt: dynoBaselineAt != null && runs.some((run) => run.at === dynoBaselineAt)
                    ? dynoBaselineAt : null })); }
            catch (e) { log.warn('virtual dyno save: ' + shortError(e)); }
        }

        // Demo dyno pull: one synthetic run so SAVED RUNS has a sample in the
        // emulator. In-memory only — saveDynoRuns() skips demo runs and
        // turning demo off purges them again.
        let demoDynoSeeded = false;
        function seedDemoDynoRun() {
            if (settings.get('demo') !== 'on') {
                if (dynoRuns.some((run) => run.demo)) {
                    dynoRuns = dynoRuns.filter((run) => !run.demo);
                    if (dynoBaselineAt != null
                        && !dynoRuns.some((run) => run.at === dynoBaselineAt)) dynoBaselineAt = null;
                    if (dynoSelectedAt != null
                        && !dynoRuns.some((run) => run.at === dynoSelectedAt)) dynoSelectedAt = null;
                    demoDynoSeeded = false;
                }
                return;
            }
            if (dynoRuns.length || demoDynoSeeded) return;
            demoDynoSeeded = true;
            const curve = [];
            for (let rpm = 1500; rpm <= 7000; rpm += 100) {
                const tq = rpm < 1900 ? 300 + (rpm - 1500) * 0.55
                    : rpm < 5200 ? 520 - (rpm - 1900) * 0.004
                    : 507 - (rpm - 5200) * 0.075;
                const powerW = Math.max(0, tq) * rpm * Math.PI / 30;
                curve.push({ rpm, powerW: Math.round(powerW), torqueNm: Math.round(Math.max(0, tq)),
                    ecuTorqueNm: Math.round(Math.max(0, tq) * 1.02) });
            }
            const peakP = curve.reduce((best, p) => p.powerW > best.powerW ? p : best, curve[0]);
            const peakT = curve.reduce((best, p) => p.torqueNm > best.torqueNm ? p : best, curve[0]);
            dynoRuns = [{
                at: Date.now() - 5400000, demo: true, curve,
                peakP: peakP.powerW, peakPrpm: peakP.rpm,
                peakT: peakT.torqueNm, peakTrpm: peakT.rpm,
                weight: 1725, loss: 18, body: 'g20', v0: 40, v1: 182,
            }];
            if (dynoSelectedAt == null) dynoSelectedAt = dynoRuns[0].at;
            dynoDisplayCleared = false;
        }

        function displayedDynoRun() {
            if (dynoDisplayCleared) return null;
            return dynoRuns.find((run) => run.at === dynoSelectedAt) || dynoRuns[0] || null;
        }

        function toggleDynoBaseline() {
            const run = displayedDynoRun();
            if (!run) return null;
            dynoBaselineAt = dynoBaselineAt === run.at ? null : run.at;
            saveDynoRuns();
            updateDynoActionLabel();
            queueRender();
            return render();
        }

        function nextDynoRun() {
            if (!dynoRuns.length) return null;
            const current = displayedDynoRun();
            const index = current ? dynoRuns.findIndex((run) => run.at === current.at) : -1;
            dynoSelectedAt = dynoRuns[(index + 1) % dynoRuns.length].at;
            dynoDisplayCleared = false;
            updateDynoActionLabel();
            queueRender();
            return render();
        }

        function selectDynoRun(at) {
            if (!dynoRuns.some((run) => run.at === at)) return null;
            dynoSelectedAt = at;
            dynoDisplayCleared = false;
            dynoView = 'run';
            updateDynoActionLabel();
            queueRender();
            return render();
        }

        function showDynoRuns() {
            dynoView = 'runs';
            updateDynoActionLabel();
            queueRender();
            return render();
        }

        function clearDynoRuns() {
            dynoRuns = [];
            dynoBaselineAt = null;
            dynoDisplayCleared = true;
            dynoSelectedAt = null;
            dynoRecorder.reset();
            lastDynoGate = null;
            demoDynoSeeded = false;
            saveDynoRuns();
            updateDynoActionLabel();
            queueRender();
            return render();
        }

        function toggleDynoView() {
            dynoView = dynoView === 'sheet' ? 'runs' : 'sheet';
            updateDynoActionLabel();
            queueRender();
            return render();
        }

        let dynoFlashAt = 0, dynoFlashKey = null, dynoFlashTimer = null;
        function dynoFlash(key) {
            dynoFlashKey = key;
            dynoFlashAt = Date.now();
            clearTimeout(dynoFlashTimer);
            dynoFlashTimer = setTimeout(queueRender, 1050);
        }

        function updateDynoActionLabel() {
            if (ui.text) ui.text('BTN_DYNO_ACTION', 'Open DYNO RUN');
            if (ui.text) ui.text('BTN_DYNO_VIEW', 'DYNO RUN');
        }

        function saveDragRuns() {
            const best = {};
            Object.keys(dragBest).forEach((key) => {
                if (!dragBest[key] || !dragBest[key].demo) best[key] = dragBest[key];
            });
            try {
                fs.writeFileSync(dragRunFile, JSON.stringify({
                    runs: dragRuns.filter((run) => !run.demo), best, selectedAt: dragSelectedAt,
                }));
            }
            catch (e) { log.warn('drag run save: ' + shortError(e)); }
        }

        function dragUnit() { return settings.get('dragSpeedUnit') === 'mph' ? 'mph' : 'kmh'; }
        function dragDistance() { return DragRun.DISTANCES[settings.get('dragDistance')] || DragRun.DISTANCES.qm; }

        // Demo history: two sample runs so DRAG HISTORY looks real in the
        // emulator. They live only in memory — saveDragRuns() skips them and
        // turning demo off purges them again.
        let demoRunsSeeded = false;
        function seedDemoDragRuns() {
            if (settings.get('demo') !== 'on') {
                warmup.clearDemo();
                if (dragRuns.some((run) => run.demo)) {
                    dragRuns = dragRuns.filter((run) => !run.demo);
                    Object.keys(dragBest).forEach((key) => {
                        if (dragBest[key] && dragBest[key].demo) delete dragBest[key];
                    });
                    if (dragSelectedAt != null
                        && !dragRuns.some((run) => run.at === dragSelectedAt)) dragSelectedAt = null;
                    demoRunsSeeded = false;
                }
                return;
            }
            if (dragRuns.length || demoRunsSeeded) return;
            demoRunsSeeded = true;
            const now = Date.now();
            dragRuns = [
                { at: now - 3600000, unit: 'kmh', demo: true,
                    result: { '0-50': 1.90, '0-100': 4.62, '100-200': 6.35,
                        '200-300': 10.20, qm: 12.40, em: 8.10 },
                    trap: { qm: 191, em: 152 }, vmax: 240, peakG: 1.05,
                    elapsed: 12.40, slope: -0.55,
                    trace: [[0, 0], [1, 32], [2, 58], [3, 82], [4.62, 100],
                        [6, 135], [8, 170], [10.97, 206], [12.4, 215]] },
                { at: now - 7200000, unit: 'kmh', demo: true, rolling: true,
                    result: { '100-200': 6.42 }, trap: {}, vmax: 200, dist: 421,
                    slope: -0.94, peakG: null,
                    trace: [[0, 100], [1, 112], [2, 128], [3, 146],
                        [4, 165], [5, 182], [6.42, 200]] },
            ];
            const rollout = settings.get('dragRollout') === true;
            dragRuns.forEach((run) => Object.keys(run.result).forEach((key) => {
                const id = DragRun.bestKey(key, run.unit, rollout), old = dragBest[id];
                if (!old || run.result[key] < old.s) {
                    dragBest[id] = { s: run.result[key], at: run.at, trap: run.trap[key], demo: true };
                }
            }));
            if (dragSelectedAt == null) dragSelectedAt = dragRuns[0].at;
        }
        function dragSelectedRun() {
            const visible = dragRuns.filter((run) => (run.unit || 'kmh') === dragUnit());
            return visible.find((run) => run.at === dragSelectedAt) || visible[0] || null;
        }

        function makeDragTimer() {
            const unit = dragUnit(), distance = dragDistance(), rollout = settings.get('dragRollout') === true;
            dragTimer = new RunTimer(DragRun.allSplits(unit), {
                rollout,
                onLaunch: () => { dragLiveCleared = false; dragPeakG = 0; dragWheelspin.launch(Date.now()); },
                onDone: (event) => {
                    const run = Object.assign({}, event, {
                        unit, distanceKey: distance.key, distanceLabel: distance.label,
                        peakG: dragPeakG, elapsed: dragTimer && dragTimer.endAt,
                        slope: slopeAt && Date.now() - slopeAt <= 5000 ? slopePct : null,
                        trace: dragTimer ? DragRun.compactTrace(dragTimer.trace) : [],
                        wheelspin: dragWheelspin.result(),
                    });
                    dragRuns.unshift(run);
                    dragRuns = dragRuns.slice(0, 30);
                    Object.keys(run.result).forEach((key) => {
                        const bestId = DragRun.bestKey(key, unit, rollout), old = dragBest[bestId];
                        if (!old || run.result[key] < old.s) {
                            dragBest[bestId] = { s: run.result[key], at: run.at, trap: run.trap[key] };
                        }
                    });
                    dragSelectedAt = run.at;
                    dragLiveCleared = false;
                    dragView = 'live';
                    dragListOffset = 0;
                    dragClearUntil = 0;
                    saveDragRuns();
                    log.info('drag run saved ' + JSON.stringify(run.result));
                    if (page === 4) queueRender();
                },
            });
            rollingTimer = new DragRun.RollingSplits(DragRun.allSplits(unit));
            lastDragState = dragTimer.state;
        }

        function feedDragSpeed(speed, at) {
            if (!dragTimer || settings.get('demo') === 'on' || !finite(speed)) return;
            dragWheelspin.speed(at, speed);
            const rollDone = rollingTimer ? rollingTimer.feed(at, speed) : {};
            const keys = Object.keys(rollDone);
            if (keys.length) {
                dragLiveCleared = false;
                const unit = dragUnit(), rollout = settings.get('dragRollout') === true;
                const inRun = dragTimer.state === 'run';
                keys.forEach((key) => {
                    const rec = rollDone[key];
                    rollingResult[key] = rec.s;
                    if (inRun) return;  // the launch run records this split itself
                    const bestId = DragRun.bestKey(key, unit, rollout), old = dragBest[bestId];
                    if (!old || rec.s < old.s) dragBest[bestId] = { s: rec.s, at };
                    dragRuns.unshift({
                        at, unit, rolling: true, result: { [key]: rec.s }, trap: {},
                        vmax: rec.vmax, dist: rec.dist, elapsed: rec.s,
                        trace: DragRun.compactTrace(rec.trace || []),
                        slope: slopeAt && at - slopeAt <= 2000 ? slopePct : null,
                        peakG: DragRun.peakGFromTrace(rec.trace),
                    });
                    dragRuns = dragRuns.slice(0, 30);
                    dragSelectedAt = at;
                });
                saveDragRuns();
                log.info('rolling split ' + JSON.stringify(rollDone));
                if (page === 4) queueRender();
            }
            const previous = dragTimer.state;
            dragTimer.feed(at, speed);
            if (previous !== dragTimer.state) {
                lastDragState = dragTimer.state;
                if (page === 4) queueRender();
            }
        }

        function toggleDragView() {
            dragView = dragView === 'live' ? 'history' : 'live';
            dragListOffset = 0;
            dragClearUntil = 0;
            queueRender();
            return render();
        }

        // History drill-down: sections -> runs(within section) -> report.
        let dragSection = null, dragRunsPage = 0;
        function dragSectionRuns() {
            const unit = dragUnit();
            return dragRuns.filter((run) => (run.unit || 'kmh') === unit
                && (!dragSection || (run.result && run.result[dragSection] != null)));
        }
        function openDragSection(key) {
            dragSection = key;
            dragView = 'runs';
            dragRunsPage = 0;
            dragListOffset = 0;
            dragClearUntil = 0;
            const first = dragSectionRuns()[0];
            if (first) dragSelectedAt = first.at;
            queueRender();
            return render();
        }
        function openDragReport(at) {
            if (!dragRuns.some((run) => run.at === at)) return null;
            dragSelectedAt = at;
            dragView = 'report';
            saveDragRuns();
            queueRender();
            return render();
        }
        function dragBack() {
            if (dragView === 'report') {
                dragView = 'runs';
                const list = dragSectionRuns(), idx = list.findIndex((run) => run.at === dragSelectedAt);
                if (idx >= 0) dragRunsPage = Math.floor(idx / DragRunUi.RUNS_PER_PAGE);
            } else if (dragView === 'runs') { dragView = 'history'; dragSection = null; dragRunsPage = 0; }
            else dragView = 'live';
            dragClearUntil = 0;
            queueRender();
            return render();
        }

        function selectDragRun(at) {
            if (!dragRuns.some((run) => run.at === at)) return null;
            dragSelectedAt = at;
            saveDragRuns();
            queueRender();
            return render();
        }

        function nextDragRun() {
            const visible = dragSectionRuns();
            if (!visible.length) return null;
            const current = dragSelectedRun();
            const index = current ? visible.findIndex((run) => run.at === current.at) : -1;
            dragSelectedAt = visible[(index + 1) % visible.length].at;
            saveDragRuns();
            queueRender();
            return render();
        }

        function shiftDragRunList(direction) {
            const count = dragRuns.filter((run) => (run.unit || 'kmh') === dragUnit()).length;
            dragListOffset = Math.max(0, Math.min(Math.max(0, count - 6), dragListOffset + direction * 6));
            queueRender();
            return render();
        }

        function resetDragTimer() {
            if (!dragTimer) return null;
            dragLiveCleared = true;
            rollingResult = {};
            dragTimer.reset();
            rollingTimer = new DragRun.RollingSplits(DragRun.allSplits(dragUnit()));
            dragPeakG = 0;
            dragWheelspin.resetRun();
            if (settings.get('demo') === 'on') {
                demoRollingCleared = true;
            }
            queueRender();
            return render();
        }

        // Two-step clear of just one section (e.g. all 0-100 records): drops the
        // split from every run that has it, removes emptied runs and the best.
        function clearDragSection(key) {
            if (!key) return null;
            const now = Date.now();
            if (now > dragClearUntil) {
                dragClearUntil = now + 5000;
                queueRender();
                return render();
            }
            dragClearUntil = 0;
            dragRuns.forEach((run) => { if (run.result) delete run.result[key]; });
            dragRuns = dragRuns.filter((run) => run.result && Object.keys(run.result).length);
            Object.keys(dragBest).forEach((id) => { if (id.split('@')[0] === key) delete dragBest[id]; });
            if (!dragSectionRuns().some((run) => run.at === dragSelectedAt)) {
                const first = dragSectionRuns()[0];
                dragSelectedAt = first ? first.at : null;
                dragRunsPage = 0;
            }
            saveDragRuns();
            queueRender();
            return render();
        }

        function clearDragHistory() {
            const now = Date.now();
            if (now > dragClearUntil) {
                dragClearUntil = now + 5000;
                queueRender();
                return render();
            }
            dragClearUntil = 0;
            dragRuns = [];
            dragBest = Object.create(null);
            dragSelectedAt = null;
            dragSection = null;
            dragRunsPage = 0;
            dragListOffset = 0;
            saveDragRuns();
            queueRender();
            return render();
        }

        makeDragTimer();

        // Reuse Engine Config's per-DME controller and Drive Mode logic. The
        // installed app starts disarmed; only the explicit setting can arm it.
        const valveKeys = { arm: 'valveControl', hold: 'valveHold' };
        const valveSettings = {
            get(key) { return settings.get(valveKeys[key] || key); },
            set(key, value) { return settings.set(valveKeys[key] || key, value); },
        };
        const valveController = new FlapController(Object.assign({}, ctx, { settings: valveSettings }));
        const valveAuto = new AutoFlap({
            controller: valveController,
            get: (key) => valveSettings.get(key), set: (key, value) => valveSettings.set(key, value),
            log, onChange: () => queueRender(),
        });
        function valveCanActuate() {
            const control = valveController.view();
            return valveReady && valveController.armedSetting && !control.blocked &&
                !!(valveController.ident && valveController.ident.elAgk && valveController.ident.elAgk.supported);
        }

        function valveBlockReason() {
            const control = valveController.view();
            if (!valveReady) return 'DIAGNOSTICS STARTING';
            if (!valveController.armedSetting) return 'CONTROL DISARMED';
            if (control.comm !== 'OK') return 'DIAGNOSTIC LINK OFFLINE';
            if (control.blocked) return 'DME CONTROL BLOCKED';
            if (!(valveController.ident && valveController.ident.elAgk && valveController.ident.elAgk.supported)) return 'NO MATCHED DME';
            return '';
        }

        function showValveNotice(text) {
            valveActionNotice = text;
            valveActionNoticeUntil = Date.now() + 5000;
            if (valveNoticeTimer) clearTimeout(valveNoticeTimer);
            valveNoticeTimer = setTimeout(() => {
                valveActionNotice = '';
                valveActionNoticeUntil = 0;
                valveNoticeTimer = null;
                queueRender();
            }, 5000);
            queueRender();
        }

        function resetMSound() {
            mSoundEnabled = false;
        }

        function mSoundActive() {
            const requested = valveAuto.effective();
            if (mSoundEnabled || requested === 'OPEN') return true;
            if (requested === 'CLOSED') return false;
            // In OEM mode the car follows its own drive-mode strategy. Sport,
            // Sport+, and Sport Individual request the open-valve behavior.
            return flapFor(drivingMode) === 'OPEN';
        }

        function dynoSetup() {
            const weight = settings.get('dynoWeight');
            const loss = settings.get('dynoLoss');
            return {
                weight: finite(weight) && weight > 0 ? weight : 1750,
                body: settings.get('dynoBody') || 'coupe',
                loss: finite(loss) ? loss : 15,
            };
        }

        function handleDynoEvent(event) {
            if (!event) return;
            if (event.type === 'short') {
                log.info('virtual dyno: pull too short to record');
                if (page === 3) queueRender();
                return;
            }
            if (event.type !== 'run') return;
            dynoRuns.unshift(event.run);
            dynoRuns = dynoRuns.slice(0, 20);
            if (dynoBaselineAt !== null && !dynoRuns.some((run) => run.at === dynoBaselineAt)) dynoBaselineAt = null;
            dynoSelectedAt = event.run.at;
            dynoDisplayCleared = false;
            saveDynoRuns();
            updateDynoActionLabel();
            log.info('virtual dyno pull ' + Math.round(Calc.powerValue(event.run.peakP / 1000, 'hp')) +
                ' hp, ' + Math.round(event.run.peakT) + ' Nm');
            diagLog('dyno_run_saved', {
                powerW: event.run.peakP, powerRpm: event.run.peakPrpm,
                torqueNm: event.run.peakT, torqueRpm: event.run.peakTrpm,
                weightKg: event.run.weight, lossPercent: event.run.loss, body: event.run.body,
            });
            if (page === 3) queueRender();
        }

        function freshWithin(m, now, maxAge) {
            return !!(m && m.at && now >= m.at && now - m.at <= maxAge && m.status === 'live' && finite(m.value));
        }

        function dynoGate(now) {
            const metrics = [['RPM', state.rpm], ['SPEED', state.speed], ['ACCEL', state.gLong]];
            const waiting = metrics.filter((entry) => !entry[1].at || entry[1].status === 'waiting').map((entry) => entry[0]);
            if (waiting.length) return { code: 'waiting', text: 'WAITING FOR ' + waiting.join(' / ') };
            const invalid = metrics.filter((entry) => entry[1].status === 'invalid').map((entry) => entry[0]);
            if (invalid.length) return { code: 'invalid', text: 'INVALID ' + invalid.join(' / ') + ' SIGNAL' };
            const stale = metrics.filter((entry) => !freshWithin(entry[1], now, DYNO_FRESH_MS)).map((entry) => entry[0]);
            if (stale.length) return { code: 'stale', text: 'STALE ' + stale.join(' / ') + ' SIGNAL' };
            const reason = Dyno.gateReason({ rpm: state.rpm.value, speedKmh: state.speed.value, longitudinalG: state.gLong.value });
            const labels = {
                speed: 'NEED SPEED >15 KM/H',
                rpm: 'NEED RPM >1200',
                acceleration: 'NEED ACCELERATION >0.12 G',
                ready: 'READY · HOLD ONE GEAR',
            };
            return { code: reason, text: labels[reason] || 'WAITING FOR LIVE SIGNALS' };
        }

        function logDynoGate(now) {
            const gate = dynoGate(now);
            if (gate.text === lastDynoGate) return;
            lastDynoGate = gate.text;
            diagLog('dyno_gate', {
                reason: gate.code, text: gate.text,
                rpm: { raw: state.rpm.raw, value: state.rpm.value, ageMs: state.rpm.at ? now - state.rpm.at : null, status: state.rpm.status },
                speed: { raw: state.speed.raw, value: state.speed.value, ageMs: state.speed.at ? now - state.speed.at : null, status: state.speed.status },
                acceleration: { raw: state.gLong.raw, value: state.gLong.value, ageMs: state.gLong.at ? now - state.gLong.at : null, status: state.gLong.status },
            });
        }

        function feedDyno() {
            if (settings.get('demo') === 'on') { dynoRecorder.reset(); return; }
            const now = Date.now();
            logDynoGate(now);
            const input = freshWithin(state.rpm, now, DYNO_FRESH_MS) &&
                freshWithin(state.speed, now, DYNO_FRESH_MS) && freshWithin(state.gLong, now, DYNO_FRESH_MS)
                ? {
                    rpm: state.rpm.value, speedKmh: state.speed.value, longitudinalG: state.gLong.value,
                    ecuTorqueNm: freshWithin(state.torqueFes, now, DYNO_FRESH_MS) ? state.torqueFes.value : null,
                }
                : null;
            handleDynoEvent(dynoRecorder.sample(input, now, dynoSetup()));
        }

        function diagLog(stage, details) {
            if (!diagnostics()) return;
            const line = 'PERF_DIAG ts=' + new Date().toISOString() + ' stage=' + stage +
                (details ? ' ' + json(details).replace(/[\r\n]+/g, ' ') : '');
            log.info(line);
        }

        function record(name, raw, value, unit, source, status) {
            if (!diagnostics()) return;
            const details = { signal: name, source: source || 'unknown', raw, value, unit: unit || '', status: status || 'live' };
            const now = Date.now(), signature = json(details), old = diagnosticDedup[name];
            if (!old || old.signature !== signature || now - old.at >= 30000) {
                diagnosticDedup[name] = { signature, at: now };
                diagLog('payload', details);
            }
        }

        function feedWarmup() {
            const now = Date.now();
            const rpm = fresh(state.rpm, now) ? state.rpm.value : null;
            const tq = fresh(state.torqueFes, now) ? state.torqueFes.value : null;
            warmup.sample({
                rpm,
                speed: fresh(state.speed, now) ? state.speed.value : null,
                oil: cdNum('oilTemp'),
                coolant: cdNum('coolantTemp'),
                gearbox: cdNum('gearboxTemp'),
                kw: finite(rpm) && finite(tq) ? tq * rpm / 9549 : null,
            });
        }

        const carDataMetricViews = {
            engineInfo: ['misfire', 'coolantTemp', 'oilTemp', 'oilLevel', 'oilPress'],
            powertrain: ['dmePower', 'airFlow', 'throttleValve', 'chargePress', 'pedalPct', 'powerPct', 'torqueFes', 'rpm', 'engineState'],
            boost: ['boostFes', 'boostDme', 'boostPeak', 'boostTargetKpa', 'iatTemp', 'engineLoad', 'engineState'],
            fuel: ['tankLitres', 'rangeKm', 'avgCons', 'fuelHp', 'fuelLp'],
            ignition: ['engineState', 'ignTiming', 'msaState', 'tankLitres', 'rangeKm'],
            drivetrain: ['gear', 'gearboxTemp', 'splitRear', 'rpm', 'torqueFes', 'engineState'],
            electrical: ['battVolt', 'battCharge', 'msaState', 'handBrake', 'odoKm'],
            tyres: ['tyrePFL', 'tyrePFR', 'tyrePRL', 'tyrePRR', 'tyrePtFL', 'tyrePtFR', 'tyrePtRL', 'tyrePtRR', 'tyreTFL', 'tyreTFR', 'tyreTRL', 'tyreTRR'],
        };
        function carDataMetricVisible(name) {
            const visible = carDataMetricViews[carDataView] || [];
            return visible.indexOf(name) >= 0;
        }

        function updateMetric(name, raw, value, unit, source, status) {
            const previous = state[name];
            const nextStatus = status || (finite(value) ? 'live' : 'invalid');
            // Ignore short invalid replies, but do not let an old gearbox value
            // look current: gearboxTemp has its own shorter freshness window.
            if ((!finite(value) || nextStatus !== 'live') && previous && previous.status === 'live' &&
                finite(previous.value) && Date.now() - previous.at <= metricStaleMs(name)) return;
            state[name] = {
                raw, value: finite(value) ? value : null, unit: unit || '', source: source || '',
                at: Date.now(), status: status || (finite(value) ? 'live' : 'invalid'),
            };
            record(name, raw, finite(value) ? value : null, unit, source, state[name].status);
            feedWarmup();
            // CAR DATA only redraws when the active section uses this metric.
            // The menu and unrelated sections stay static while telemetry streams.
            if (page === 0 || page === 3 || page === 4 || page === 6 ||
                (page === 5 && carDataMetricVisible(name))) queueRender();
        }

        function onProvider(iface, available) {
            state.providers[iface] = !!available;
            diagLog('provider', { interface: iface, available: !!available });
            if (page !== 5) queueRender();
        }

        function onRuntimeDiagnostic(event) {
            if (!diagnostics() || !event) return;
            diagLog('someip_' + (event.stage || 'event'), {
                interface: event.iface, instance: event.instance, detail: event.detail || {},
            });
        }

        function startWatch(iface, handlers, watchOptions) {
            let pending;
            try {
                pending = ctx.signals.watch(iface, '1', handlers, log, {
                    onAvailability: (available) => onProvider(iface, available),
                    onDiagnostic: onRuntimeDiagnostic,
                    ...(watchOptions || {}),
                });
            } catch (e) {
                diagLog('watch_call_error', { interface: iface, error: shortError(e) });
                log.warn('Performance signal ' + iface + ': ' + shortError(e));
                return Promise.resolve(null);
            }
            return Promise.resolve(pending).then((sub) => {
                if (!sub) {
                    diagLog('watch_completed', { interface: iface, result: 'no result' });
                    return null;
                }
                subscriptions.push(sub);
                if (sub.proxy && iface === TPMS) tpmsProxy = sub.proxy;
                diagLog('watch_completed', { interface: iface, error: sub.error || null, available: sub.available === true });
                if (sub.error) {
                    log.warn('Performance signal ' + iface + ': ' + sub.error);
                    onProvider(iface, false);
                } else if (typeof sub.available === 'boolean') onProvider(iface, sub.available);
                if (state.stopped) shutdownSubscription(sub);
                return sub;
            }).catch((e) => {
                diagLog('watch_rejected', { interface: iface, error: shortError(e) });
                log.warn('Performance signal ' + iface + ': ' + shortError(e));
                return null;
            });
        }

        function shutdownSubscription(sub) {
            if (!sub || typeof sub.shutdown !== 'function') return;
            Promise.resolve().then(() => sub.shutdown()).catch((e) => log.warn('signal shutdown: ' + shortError(e)));
        }

        function setRpm(payload, source) {
            const raw = payload && payload.actualValueRPMEngineCrankshaft;
            const value = Calc.rpm(raw, scaling.rpm);
            updateMetric('rpm', raw, value, 'rpm', source, value === null ? 'invalid' : 'live');
            feedDyno();
        }

        function setVehicleSpeed(payload, source) {
            const raw = payload && payload.speedVehicleCentreOfGravity;
            const value = Calc.scale(raw, scaling.speed);
            const valid = finite(value) && value >= 0 && value <= 400;
            const at = Date.now();
            updateMetric('speed', raw, valid ? value : null, 'km/h', source, valid ? 'live' : 'invalid');
            if (valid) {
                feedDragSpeed(value, at);
                slopeSpeeds.push({ t: at, v: value });
                while (slopeSpeeds.length && at - slopeSpeeds[0].t > 1600) slopeSpeeds.shift();
            }
            updateSlope(at);
            feedDyno();
        }

        function updateSlope(now) {
            if (accelMps2 === null || now - accelAt > 800) return;
            let dvdt = 0;
            const newest = slopeSpeeds.length ? slopeSpeeds[slopeSpeeds.length - 1] : null;
            if (newest) {
                let old = null;
                for (let i = slopeSpeeds.length - 1; i >= 0; i--) {
                    if (newest.t - slopeSpeeds[i].t >= 320) { old = slopeSpeeds[i]; break; }
                }
                if (old && newest.t - old.t > 100) dvdt = (newest.v - old.v) / 3.6 / ((newest.t - old.t) / 1000);
            }
            const raw = Math.max(-30, Math.min(30, (accelMps2 - dvdt) / 9.80665 * 100));
            slopePct = slopePct === null ? raw : slopePct + (raw - slopePct) * 0.25;
            slopeAt = now;
        }

        // CDS engine temperatures: coolant drive + oil drive, deg C = raw - 48 (raw 0 / 255 = no data).
        function setEngineTemps(payload, source) {
            if (!payload) return;
            const rawOil = payload.temperatureEngineOilDrive;
            const oil = Calc.scale(rawOil, scaling.engineTemp);
            updateMetric('oilTemp', rawOil, finite(oil) && rawOil > 0 ? oil : null, 'degC', source,
                finite(oil) && rawOil > 0 ? 'live' : 'invalid');
            const rawCool = payload.temperatureEngineDrive;
            const cool = Calc.scale(rawCool, scaling.engineTemp);
            updateMetric('coolantTemp', rawCool, finite(cool) && rawCool > 0 ? cool : null, 'degC', source,
                finite(cool) && rawCool > 0 ? 'live' : 'invalid');
        }

        // BasicDataSet: EGS transmission oil temperature, same deg C = raw - 48 scale.
        function setGearboxTemp(payload, source) {
            const raw = payload && payload.valueTemperatureTransmissionOil;
            const value = Calc.scale(raw, scaling.gearboxTemp);
            updateMetric('gearboxTemp', raw, finite(value) && raw > 0 ? value : null, 'degC', source,
                finite(value) && raw > 0 ? 'live' : 'invalid');
            // xDrive torque split to the rear axle (%): valid when its qualifier says so
            // or the car leaves the qualifier out entirely (same rules as car_vitals).
            const rawSplit = payload && payload.valueDistributionLongitudinalTorqueRearAxisFrontAxis;
            const q = payload && payload.qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis;
            const splitOk = q === undefined || q === null || /^(2|10|SIGNALWERT_IST_GUELTIG)$/.test(String(q));
            const split = splitOk ? Calc.scale(rawSplit, { factor: 0.01, invalid: 65535 }) : null;
            if (finite(split) && split >= 0 && split <= 100) updateMetric('splitRear', rawSplit, split, '%', source, 'live');
        }

        function setGearboxStatus(payload) {
            if (!payload) return;
            const gear = gearNumber(payload.statusActualGearDrive);
            const stage = DRIVE_STAGES[payload.statusActualStageDrive];
            const label = stage ? (stage === 'D' && gear > 0 ? 'D' + gear : stage)
                : gear === -1 ? 'R' : gear === 0 ? 'N/P' : gear > 0 ? String(gear) : null;
            if (!label) return;
            vehicleGear = label;
            vehicleGearAt = Date.now();
            if (page === 0 || (page === 5 && carDataView === 'drivetrain')) queueRender();
        }

        function setGearSelection(payload) {
            const label = selectedGearLabel(payload && payload.statusGearSelectionDrive);
            if (!label) return;
            vehicleGear = label;
            vehicleGearAt = Date.now();
            if (page === 0 || (page === 5 && carDataView === 'drivetrain')) queueRender();
        }

        function setLongitudinalAcceleration(payload, source) {
            const raw = payload && payload.longitudinalAccelerationCentreOfGravity;
            const mps2 = Calc.scale(raw, scaling.accel);
            const value = finite(mps2) ? mps2 / 9.80665 : null;
            const valid = finite(value) && Math.abs(value) <= 8;
            updateMetric('gLong', raw, valid ? value : null, 'g', source, valid ? 'live' : 'invalid');
            accelMps2 = valid ? mps2 : null;
            accelAt = Date.now();
            updateSlope(accelAt);
            if (settings.get('demo') !== 'on') {
                dragWheelspin.accel(Date.now(), valid ? mps2 : null);
                if (dragTimer && dragTimer.state === 'run' && valid) dragPeakG = Math.max(dragPeakG, value);
            }
            feedDyno();
        }

        function setFesTorque(payload, source) {
            const raw = payload && payload.actualValueTorqueCrankshaft;
            const value = Calc.torque(raw, scaling.torque);
            updateMetric('torqueFes', raw, value, 'Nm', source, value === null ? 'invalid' : 'live');
            feedDyno();
        }

        function setFesPercentages(payload, source) {
            const power = payload && payload.displaySportEnginePower;
            const torque = payload && payload.displaySportEngineTorque;
            const p = Calc.percentage(power, scaling.sportPct);
            const t = Calc.percentage(torque, scaling.sportPct);
            updateMetric('powerPct', power, p, '%', source, p === null ? 'invalid' : 'live');
            updateMetric('torquePct', torque, t, '%', source, t === null ? 'invalid' : 'live');
        }

        function setFesBoost(payload, source) {
            const raw = payload && payload.displayBoostPressure;
            const value = Calc.fesBoostBar(raw, state.pressureUnit, scaling.boost);
            if (finite(value)) {
                if (firstFesBoost === null) firstFesBoost = value;
                else if (source !== 'reconvert' && Math.abs(value - firstFesBoost) >= 0.03) fesBoostTrusted = true;
            }
            updateMetric('boostFes', raw, value, 'bar', source,
                value === null ? (raw === 255 ? 'invalid' : 'unit-unknown') : 'live');
            const peakRaw = payload && payload.displayMaximumValueBoostPressure;
            const peak = Calc.fesBoostBar(peakRaw, state.pressureUnit, scaling.boost);
            if (finite(peak) && peak > 0) updateMetric('boostPeak', peakRaw, peak, 'bar', source, 'live');
        }

        function tyrePressureBar(raw) {
            if (!finite(raw) || raw >= 65532) return null;
            const valueInUnit = raw * 0.1;
            const factor = PRESS_TO_BAR[state.pressureUnit];
            const value = factor ? valueInUnit * factor
                : valueInUnit >= 0.5 && valueInUnit <= 6 ? valueInUnit
                    : valueInUnit >= 7 && valueInUnit < 60 ? valueInUnit / 14.5038
                        : valueInUnit >= 60 && valueInUnit <= 600 ? valueInUnit / 100 : valueInUnit;
            return finite(value) && value > 0 && value < 7 ? value : null;
        }
        function tyreTemperatureC(raw) {
            if (!finite(raw) || raw === 65535) return null;
            let value = raw - 40;
            if (state.tempUnit === 'F') value = (value - 32) * 5 / 9;
            return finite(value) && value > -40 && value < 120 ? value : null;
        }
        function reconvertTyreMetrics(keys, decoder, unit, source) {
            keys.forEach((key) => {
                const previous = state[key];
                if (!previous || previous.raw === undefined) return;
                const value = decoder(previous.raw);
                updateMetric(key, previous.raw, value, unit, source,
                    finite(value) ? 'live' : 'invalid');
            });
        }
        const tyrePressureKeys = ['tyrePFL', 'tyrePFR', 'tyrePRL', 'tyrePRR', 'tyrePtFL', 'tyrePtFR', 'tyrePtRL', 'tyrePtRR'];
        const tyreTemperatureKeys = ['tyreTFL', 'tyreTFR', 'tyreTRL', 'tyreTRR'];
        function setPressureUnits(payload, source) {
            const raw = payload && payload.unitOfMeasurementAirPressure;
            const unit = pressureUnit(raw);
            state.pressureUnit = unit;
            const tempRaw = payload && payload.unitOfMeasurementTemperature;
            const tempValue = tempRaw && typeof tempRaw === 'object' ? (tempRaw.name || tempRaw.value) : tempRaw;
            state.tempUnit = ({ 1: 'C', 2: 'F', C: 'C', F: 'F' })[typeof tempValue === 'string' ? tempValue.trim().toUpperCase() : tempValue] || state.tempUnit || null;
            diagLog('pressure_units', { source, raw, unit: unit || 'unknown' });
            if (state.boostFes.at) setFesBoost({ displayBoostPressure: state.boostFes.raw }, 'reconvert');
            reconvertTyreMetrics(tyrePressureKeys, tyrePressureBar, 'bar', 'reconvert');
            reconvertTyreMetrics(tyreTemperatureKeys, tyreTemperatureC, 'degC', 'reconvert');
            if (page !== 5 || carDataMetricVisible('boostFes')) queueRender();
        }

        /* ---- CAR DATA tab decoders: enums become text metrics, numbers become metrics ---- */
        const ENGINE_STATES = { MOTOR_AUS: 'ENGINE OFF', MOTOR_STARTET: 'STARTING', MOTOR_LAEUFT: 'RUNNING', 0: 'ENGINE OFF', 1: 'STARTING', 2: 'RUNNING' };
        const MSA_STATES = { MSA_AKTIVIERT: 'ON', MSA_DEAKTIVIERT: 'OFF', 0: 'OFF', 1: 'ON' };
        const BRAKE_STATES = { HANDBREMSE_ANGEZOGEN: 'APPLIED', HANDBREMSE_GELOEST: 'RELEASED', 1: 'RELEASED', 2: 'APPLIED' };
        const OIL_LEVELS = { MOTOROELSTAND_UNTER_MINIMUM: 'BELOW MIN', MOTOROELSTAND_AM_MINIMUM: 'AT MINIMUM',
            MOTOROELSTAND_1_4: '1/4', MOTOROELSTAND_2_4: '2/4', MOTOROELSTAND_3_4: '3/4', MOTOROELSTAND_4_4: 'FULL',
            MOTOROELSTAND_5_4: 'ABOVE FULL', MOTOROELSTAND_UEBERFUELLT: 'OVERFILLED', MOTOROELSTAND_OK: 'OK',
            SERVICEFUNKTION_AKTIV: 'MEASURING', 0: 'BELOW MIN', 1: 'AT MINIMUM', 2: '1/4', 3: '2/4',
            4: '3/4', 5: 'FULL', 6: 'ABOVE FULL', 7: 'OVERFILLED', 13: 'OK', 14: 'MEASURING' };
        const CONS_UNITS = { VERBRAUCH_IN_L_S_100KM: 'l/100km', VERBRAUCH_IN_MPG_UK: 'mpg', VERBRAUCH_IN_MPG_US: 'mpg US', VERBRAUCH_IN_KM_S_L: 'km/l', 1: 'l/100km', 2: 'mpg', 3: 'mpg US', 4: 'km/l' };

        function textMetric(name, text, source) {
            const previous = state[name];
            if (!text && previous && previous.status === 'live' && previous.text &&
                Date.now() - previous.at <= CD_STALE) return;
            state[name] = { raw: text, value: null, text: text || null, unit: '', source: source || '', at: Date.now(), status: text ? 'live' : 'invalid' };
            record(name, text, text, '', source, state[name].status);
            if (page !== 1 && (page !== 5 || carDataMetricVisible(name))) queueRender();
        }

        function setAmbient(payload, source) {
            const raw = payload && payload.temperatureExterior;
            const value = Calc.scale(raw, { factor: 0.5, offset: -40, invalid: 255 });
            updateMetric('ambientTemp', raw, value, 'degC', source, value === null ? 'invalid' : 'live');
        }
        function setEngineStatus(payload, source) { textMetric('engineState', ENGINE_STATES[payload && payload.statusEngineRunDrive], source); }
        function enumStatus(raw, table, classify) {
            const direct = table[raw];
            if (direct) return direct;
            if (typeof raw !== 'string') return null;
            const value = raw.toUpperCase();
            if (/INVALID|INITIAL|UNKNOWN|NO_VALUE|NICHT_VERFUEGBAR/.test(value)) return null;
            return classify(value);
        }
        function setBattery(payload, source) {
            const raw = payload && payload.conditionBatteryChargingCondition;
            updateMetric('battCharge', raw, finite(raw) && raw >= 0 && raw <= 100 ? raw : null, '%', source, 'live');
        }
        function setHandBrake(payload, source) {
            const raw = payload && payload.statusContactHandBrake;
            const normalized = typeof raw === 'boolean' ? String(raw).toUpperCase() : raw;
            const value = enumStatus(normalized, BRAKE_STATES, (s) => /^(TRUE|ON|1)$/.test(s) ? 'APPLIED'
                : /^(FALSE|OFF|0)$/.test(s) ? 'RELEASED'
                    : /NICHT.*(ANGEZOG|BETAETIG|BETÄTIG|FESTGESTELLT|APPLIED)/.test(s) ? 'RELEASED'
                        : /NICHT.*(GELOES|GELÖS|LOESEN|LÖSEN|OFFEN|RELEASED)/.test(s) ? 'APPLIED'
                            : /ANGEZOG|BETAETIG|BETÄTIG|FESTGESTELLT|APPLIED/.test(s) ? 'APPLIED'
                                : /GELOES|GELÖS|LOESEN|LÖSEN|OFFEN|RELEASED/.test(s) ? 'RELEASED' : null);
            textMetric('handBrake', value, source);
        }
        function setMsa(payload, source) {
            const raw = payload && payload.statusFunctionMSA;
            const value = enumStatus(raw, MSA_STATES, (s) => /DEAKTIV|DISABL|OFF|NICHT.*(AKTIV|ENABL|ON)/.test(s) ? 'OFF'
                : /AKTIV|ENABL|ON/.test(s) ? 'ON' : null);
            textMetric('msaState', value, source);
        }
        function setOilLevel(payload, source) { textMetric('oilLevel', OIL_LEVELS[payload && payload.fluidLevelEngineOilRelative], source); }
        function setMass(payload, source) {
            const raw = payload && payload.massVehicle;
            updateMetric('vehicleMass', raw, finite(raw) && raw > 500 && raw < 5000 ? raw : null, 'kg', source, 'live');
        }
        function setTank(payload, source) {
            if (!payload) return;
            const tank = payload.fluidLevelFuelTank;
            const validTank = finite(tank) && tank >= 0 && tank <= 200;
            updateMetric('tankLitres', tank, validTank ? tank : null, 'l', source, validTank ? 'live' : 'invalid');
            if (validTank) updateFuelReserve(tank);
            const range = payload.range;
            updateMetric('rangeKm', range, finite(range) && range >= 0 && range < 4095 ? range : null, 'km', source, 'live');
            const odo = payload.mileageKilometre;
            updateMetric('odoKm', odo, finite(odo) && odo >= 0 && odo < 16777215 ? odo : null, 'km', source, 'live');
        }

        let fuelReserveUntil = 0, fuelReserveLatched = false, fuelReserveTimer = null;
        function updateFuelReserve(litres) {
            if (litres > 9) fuelReserveLatched = false;
            if (litres > 8 || fuelReserveLatched) return;
            fuelReserveLatched = true;
            fuelReserveUntil = Date.now() + 5000;
            if (fuelReserveTimer) clearTimeout(fuelReserveTimer);
            fuelReserveTimer = setTimeout(() => {
                fuelReserveTimer = null;
                fuelReserveUntil = 0;
                queueRender();
            }, 5000);
            queueRender();
        }
        function setBoardAvg(payload, source) {
            const raw = payload && payload.consumptionAverage1BC1;
            const unit = CONS_UNITS[payload && payload.statusUnitOfMeasurementConsumptionBC] || 'l/100km';
            const value = Calc.scale(raw, { factor: 0.1, invalid: 65535 });
            textMetric('avgCons', finite(value) && value >= 0 && value <= 100 ? formatNumber(value, 1) + ' ' + unit : null, source);
        }
        function setPedal(payload, source) {
            const raw = payload && payload.actualValueAngleAcceleratorPedal;
            const value = Calc.scale(raw, { factor: 0.025 });
            updateMetric('pedalPct', raw, finite(value) && value >= 0 && value <= 105 ? value : null, '%', source, 'live');
        }
        // TPMS: 0.1 per bit in the car's pressure unit; temperatures are deg C + 40 (deg F on a car set so).
        const PRESS_TO_BAR = { BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 };
        function setTyrePress(payload, source) {
            if (!payload) return;
            [['tyrePFL', 'actualValuePressureTyreFLH'], ['tyrePFR', 'actualValuePressureTyreFRH'],
             ['tyrePRL', 'actualValuePressureTyreRLH'], ['tyrePRR', 'actualValuePressureTyreRRH']].forEach(([key, field]) => {
                const raw = payload[field];
                const value = tyrePressureBar(raw);
                updateMetric(key, raw, value, 'bar', source, finite(value) ? 'live' : 'invalid');
            });
        }
        function setTyreTarget(payload, source) {
            if (!payload) return;
            [['tyrePtFL', 'targetPressureTyreFLH'], ['tyrePtFR', 'targetPressureTyreFRH'],
             ['tyrePtRL', 'targetPressureTyreRLH'], ['tyrePtRR', 'targetPressureTyreRRH']].forEach(([key, field]) => {
                const raw = payload[field];
                const value = tyrePressureBar(raw);
                updateMetric(key, raw, value, 'bar', source, finite(value) ? 'live' : 'invalid');
            });
        }
        function setTyreTemp(payload, source) {
            if (!payload) return;
            [['tyreTFL', 'actualValueTemperatureTyreFLH'], ['tyreTFR', 'actualValueTemperatureTyreFRH'],
             ['tyreTRL', 'actualValueTemperatureTyreRLH'], ['tyreTRR', 'actualValueTemperatureTyreRRH']].forEach(([key, field]) => {
                const raw = payload[field];
                const value = tyreTemperatureC(raw);
                updateMetric(key, raw, value, 'degC', source, finite(value) ? 'live' : 'invalid');
            });
        }

        // The car's richer tyre info (aref_tires decode): detection status, last reset, fitted
        // sizes, what the sensors report, selection/loading state, and what DSC is doing.
        // Each watched field is its own struct payload.
        const tyreExtra = {};
        const tyreStore = (key, fn) => (payload) => {
            if (!payload) return;
            const v = fn(payload);
            if (v) { tyreExtra[key] = v; if (page === 5 && carDataView === 'tyres') queueRender(); }
        };
        const setTyreDetection = tyreStore('detection', TyreData.detection);
        const setTyreCalibration = tyreStore('calibration', TyreData.calibration);
        const setTyreFront = tyreStore('frontTire', TyreData.frontAxle);
        const setTyreRear = tyreStore('rearTire', TyreData.rearAxle);
        const setTyreSensor = tyreStore('sensorTire', TyreData.sensorTire);
        const setTyreState = tyreStore('tyreState', TyreData.tyreState);
        // tpmsInternalLastValues: per-sensor last reported values (mbar/degC). Backup feed
        // for cars that never notify statusTyrePressure/statusTargetTyrePressure. Raw is
        // stored in the same format the TPMS decoders expect so unit reconversion stays right.
        const setTyreLastValues = (payload) => {
            const list = TyreData.lastValues(payload);
            if (!list) return;
            const pressFactor = PRESS_TO_BAR[state.pressureUnit];
            list.forEach((s) => {
                if (finite(s.pressureMbar) && s.pressureMbar > 0) {
                    const bar = s.pressureMbar / 1000;
                    const raw = Math.round((pressFactor ? bar / pressFactor : bar) * 10);
                    updateMetric('tyreP' + s.corner, raw, tyrePressureBar(raw), 'bar', 'tpms-internal',
                        finite(tyrePressureBar(raw)) ? 'live' : 'invalid');
                }
                if (finite(s.targetMbar) && s.targetMbar > 0) {
                    const bar = s.targetMbar / 1000;
                    const raw = Math.round((pressFactor ? bar / pressFactor : bar) * 10);
                    updateMetric('tyrePt' + s.corner, raw, tyrePressureBar(raw), 'bar', 'tpms-internal',
                        finite(tyrePressureBar(raw)) ? 'live' : 'invalid');
                }
                if (finite(s.tempC)) {
                    const raw = Math.round(state.tempUnit === 'F' ? s.tempC * 9 / 5 + 72 : s.tempC + 40);
                    updateMetric('tyreT' + s.corner, raw, tyreTemperatureC(raw), 'degC', 'tpms-internal',
                        finite(tyreTemperatureC(raw)) ? 'live' : 'invalid');
                }
            });
        };
        const setDsc = (payload) => {
            const v = TyreData.dsc(payload);
            if (v) {
                tyreExtra.dsc = v;
                if (page === 0 || (page === 5 && carDataView === 'tyres') || (page === 1 && engineConfigView === 'dynamic')) queueRender();
            }
        };

        // ---- DYNAMIC CONFIG: DSC requests through TPMS.chassisControl ----
        // Confirm the safety-reducing OFF command twice while parked; read back the
        // actual mode from FES.statusDSCSwitchHMI instead of treating an accepted write as success.
        let tpmsProxy = null;
        const dscWrite = { busy: false, armed: null, armedUntil: 0, status: '', warn: false };
        // These two request enums are documented by the TPMS chassisControl reference.
        // MDM's request enum is not verified; never send guessed values to the stability system.
        const DSC_ENUMS = { on: 'DSC_EINSCHALTEN', off: 'DSC_AUSSCHALTEN' };
        const DSC_LABEL = { on: 'DSC ON', mdm: 'MDM', off: 'DSC OFF' };
        function dscStatus(text, warn) {
            dscWrite.status = text; dscWrite.warn = !!warn;
            queueRender();
        }
        function dscSend(mode) {
            const value = DSC_ENUMS[mode];
            if (!value) {
                dscWrite.busy = false;
                dscStatus('MDM NOT VERIFIED · USE CAR BUTTON', true);
                return;
            }
            let pending;
            try { pending = ctx.signals.set(tpmsProxy, 'chassisControl', TyreData.dscStruct(value)); }
            catch (e) { pending = Promise.reject(e); }
            Promise.resolve(pending).then(() => {
                log.info('dsc ' + mode + ' request accepted via ' + value);
                dscStatus('REQUEST SENT · CHECKING CLUSTER');
                [1500, 4000].forEach((ms, j) => setTimeout(() => {
                    const d = tyreExtra.dsc;
                    if (j === 1) {
                        dscWrite.busy = false;
                        dscStatus(d && d.state === mode ? DSC_LABEL[mode] + ' ACTIVE'
                            : 'NOT CONFIRMED · CLUSTER ' + (d ? d.state.toUpperCase() : 'UNKNOWN'),
                            !(d && d.state === mode));
                    } else queueRender();
                }, ms));
            }, (e) => {
                dscWrite.busy = false;
                log.warn('dsc ' + value + ': ' + shortError(e));
                dscStatus(DSC_LABEL[mode] + ' · REFUSED BY CAR', true);
            });
        }
        function dscRequest(mode) {
            if (settings.get('demo') === 'on') return dscStatus(DSC_LABEL[mode] + ' · DEMO MODE', false);
            if (!DSC_ENUMS[mode]) return dscStatus('MDM NOT VERIFIED · USE CAR BUTTON', true);
            if (dscWrite.busy) { dscStatus('COMMAND IN PROGRESS', true); return null; }
            if (mode === 'on') {
                if (tyreExtra.dsc && tyreExtra.dsc.state === 'on') return dscStatus('DSC ON ALREADY ACTIVE', false);
                dscWrite.armed = null;
                if (!tpmsProxy) return dscStatus('TPMS LINK UNAVAILABLE', true);
                dscWrite.busy = true;
                dscStatus('SENDING DSC ON', false);
                dscSend('on');
                return null;
            }
            const now = Date.now();
            if (!fresh(state.speed, now)) return dscStatus('DSC OFF LOCKED · WAIT FOR SPEED', true);
            if (state.speed.value >= 0.5) return dscStatus('DSC OFF LOCKED · STOP FIRST', true);
            const currentDsc = tyreExtra.dsc && tyreExtra.dsc.state;
            if (!currentDsc) return dscStatus('DSC OFF LOCKED · WAIT FOR STATUS', true);
            if (currentDsc === 'off') return dscStatus('DSC OFF ALREADY ACTIVE', false);
            if (currentDsc !== 'on') return dscStatus('DSC OFF LOCKED · ENABLE DSC FIRST', true);
            if (dscWrite.armed !== mode || now > dscWrite.armedUntil) {
                dscWrite.armed = mode; dscWrite.armedUntil = now + 4000;
                dscStatus('PRESS AGAIN TO SEND ' + DSC_LABEL[mode], mode === 'off');
                return null;
            }
            dscWrite.armed = null;
            if (!tpmsProxy) { dscStatus('TPMS LINK UNAVAILABLE', true); return null; }
            dscWrite.busy = true;
            dscStatus('SENDING ' + DSC_LABEL[mode], false);
            dscSend(mode);
            return null;
        }
        const dscActions = {
            dscOn() { return dscRequest('on'); },
            dscMdm() { return dscRequest('mdm'); },
            dscOff() { return dscRequest('off'); },
        };

        // ENGINE DATA chip: cycles only between verified DSC ON/OFF requests.
        function dscGo(mode) {
            if (settings.get('demo') === 'on') return dscStatus(DSC_LABEL[mode] + ' · DEMO MODE', false);
            if (!DSC_ENUMS[mode]) return dscStatus('MDM NOT VERIFIED · USE CAR BUTTON', true);
            if (mode === 'off') return dscRequest('off');
            if (dscWrite.busy) { dscStatus('COMMAND IN PROGRESS', true); return null; }
            if (!tpmsProxy) { dscStatus('TPMS LINK UNAVAILABLE', true); return null; }
            dscWrite.busy = true;
            dscStatus('SENDING ' + DSC_LABEL[mode], false);
            dscSend(mode);
            return null;
        }
        function dscCycle() {
            const order = ['on', 'off'];
            const cur = tyreExtra.dsc && tyreExtra.dsc.state;
            const nxt = order[(order.indexOf(cur) + 1) % order.length];
            return dscGo(nxt);
        }

        function currentValveView() {
            const control = valveController.view();
            const matched = !!(valveController.ident && valveController.ident.elAgk &&
                valveController.ident.elAgk.supported);
            const armed = valveController.armedSetting;
            let status;
            if (!valveReady) status = 'STARTING DIAGNOSTIC LINK';
            else if (!armed) status = 'SAFE MODE · DISARMED';
            else if (control.comm !== 'OK') status = 'TASU DIAGNOSTIC LINK UNAVAILABLE';
            else if (!matched) status = 'NO MATCHED ELECTRIC FLAP';
            else if (control.blocked) status = 'DME FOUND · CONTROL BLOCKED';
            else status = 'BMW DME · FLAP CAPABILITY MATCHED';

            const lines = [];
            if (!armed) {
                lines.push('Car control is off in app settings.');
                lines.push('No valve commands are sent in this mode.');
            } else if (!matched) {
                lines.push('No supported electric-flap readback found.');
                lines.push(control.dme ? 'DME: ' + control.dme : 'DME identity not available.');
            } else {
                lines.push(control.dme ? 'DME: ' + control.dme + ' · read-only match' : 'DME capability matched.');
                if (control.confirmed !== 'UNKNOWN') lines.push('DME target: ' + control.confirmed + ' · physical position unverified.');
                else if (control.accepted === true) lines.push('DME accepted the request; target readback unavailable.');
                else if (control.accepted === false) lines.push('Last request was not confirmed by the DME.');
                else lines.push('Select a valve command or Drive Mode.');
            }
            const note = valveAuto.note();
            if (note && lines.length < 3) lines.push(note.text);
            const visualState = control.simulated ? 'UNKNOWN' : (control.confirmed || 'UNKNOWN');
            const demoPreview = settings.get('demo') === 'on' && !valveCanActuate() && demoSelectedMode;
            const selectedMode = demoPreview || valveAuto.selected();
            const effectiveMode = demoPreview
                ? (demoPreview === 'DRIVE' ? (flapFor(drivingMode) || 'OEM') : demoPreview)
                : valveAuto.effective();
            const modeLabel = selectedMode === 'DRIVE' ? 'DRIVE' : effectiveMode;
            let commandStatus;
            if (!valveReady) commandStatus = 'DIAGNOSTIC LINK STARTING';
            else if (!armed) commandStatus = 'DISARMED · NO COMMAND SENT';
            else if (control.comm !== 'OK') commandStatus = 'DIAGNOSTIC LINK UNAVAILABLE';
            else if (!matched) commandStatus = 'WAITING FOR MATCHED DME';
            else if (control.blocked) commandStatus = 'CONTROL BLOCKED';
            else if (valveCommandActive || control.busy) commandStatus = 'COMMAND IN PROGRESS';
            else if (control.accepted === false) commandStatus = 'LAST COMMAND NOT ACCEPTED';
            else if (control.accepted === true) commandStatus = 'DME ACCEPTED · POSITION UNKNOWN';
            else commandStatus = 'READY FOR COMMAND';
            if (valveActionNotice && Date.now() < valveActionNoticeUntil) commandStatus = valveActionNotice;
            const tune = control.tune || {};
            if (typeof tune.burbles === 'number' && tune.burbles <= 12) burbleTarget = tune.burbles;
            return Object.assign({}, control, {
                ready: valveReady, armed, matched, status, lines, visualState, commandStatus,
                // The exhaust art follows the requested mode as a visual cue only;
                // the DME's reported position is separately labelled unverified.
                exhaustMode: effectiveMode,
                modeLabel,
                drivingMode: modeName(drivingMode),
                driveModeLoading,
                page, selected: selectedMode,
                requested: valveAuto.desired,
                note: note && note.text,
                bm3Rom: control.bm3 && control.bm3.rom,
                bm3Error: control.bm3 && control.bm3.error,
                burbleTarget,
            });
        }

        function stopDriveModePoll() {
            if (driveModePollTimer) { clearTimeout(driveModePollTimer); driveModePollTimer = null; }
            const sub = driveModePollSub;
            driveModePollSub = null;
            if (sub) shutdownSubscription(sub);
        }

        function retryDriveModePoll() {
            if (state.stopped || driveModeConfirmed || driveModePollTimer) return;
            driveModePollTimer = setTimeout(() => {
                driveModePollTimer = null;
                startDriveModePoll();
            }, 5000);
        }

        function startDriveModePoll() {
            if (state.stopped || driveModeConfirmed || driveModePollStarting || driveModePollSub || driveModePollTimer) return;
            driveModeLoading = true;
            driveModePollStarting = true;
            queueRender();
            // The regular FES subscription handles changes. This one-field
            // read-only poll keeps checking at a low rate until BMW reports a
            // valid mode; some cars publish it after the other live signals.
            startWatch(FES, { statusFESVehicleDynamicSwitchHMI: applyDrivingMode }, {
                pollMs: 3000,
                onDiagnostic: () => {},
            }).then((sub) => {
                driveModePollStarting = false;
                if (driveModeConfirmed || state.stopped) {
                    if (sub) shutdownSubscription(sub);
                    return;
                }
                if (!sub || sub.error) {
                    if (sub) shutdownSubscription(sub);
                    driveModeLoading = true;
                    queueRender();
                    retryDriveModePoll();
                    return;
                }
                driveModePollSub = sub;
            });
        }

        function applyDrivingMode(payload) {
            const raw = payload && payload.actualValueModeDrivingExperience;
            if (raw === undefined || raw === null) return;
            if (!flapFor(raw)) {
                if (drivingMode === null) {
                    driveModeLoading = true;
                    queueRender();
                }
                return;
            }
            const changed = drivingMode === null || String(drivingMode) !== String(raw);
            const needsRender = changed || !driveModeConfirmed || driveModeLoading;
            drivingMode = raw;
            driveModeConfirmed = true;
            driveModeLoading = false;
            stopDriveModePoll();
            // Refresh the mode badge even when exhaust control is disarmed.
            if (needsRender) queueRender();
            if (changed) settings.set('lastDriveMode', raw);
            if (!valveCanActuate()) { valveAuto.drive = raw; return; }
            const pending = valveAuto.driveMode(raw);
            if (pending) pending.then(queueRender).catch((e) => log.warn('exhaust drive mode: ' + shortError(e)));
            else queueRender();
        }

        const valvePress = (mode) => () => {
            if (mode === 'DRIVE' && drivingMode === null) startDriveModePoll();
            if (!valveCanActuate()) {
                if (settings.get('demo') === 'on') demoSelectedMode = mode;
                const reason = valveBlockReason();
                showValveNotice(mode + ' NOT SENT · ' + (reason || 'CONTROL UNAVAILABLE'));
                diagLog('valve_command_blocked', { mode, ready: valveReady,
                    armed: valveController.armedSetting,
                    matched: !!(valveController.ident && valveController.ident.elAgk && valveController.ident.elAgk.supported) });
                return null;
            }
            if (valveScanBusy || valveController.tune.busy || burbleCommandActive ||
                (valveController.state.busy && mode !== 'OEM')) {
                showValveNotice(mode + ' NOT SENT · COMMAND IN PROGRESS');
                return null;
            }
            const startedAt = Date.now();
            valveCommandActive = true;
            const pending = valveAuto.press(mode);
            diagLog('valve_command_started', { mode });
            queueRender();
            const finish = () => {
                const elapsedMs = Date.now() - startedAt;
                valveCommandActive = false;
                valvePriorityUntil = Date.now() + 1200;
                const result = valveController.state;
                const details = { mode, elapsedMs, accepted: result.accepted, confirmed: result.confirmed };
                diagLog('valve_command_finished', details);
                log.info('exhaust ' + mode + ' request finished in ' + elapsedMs + ' ms; accepted=' + result.accepted + ', physical position unverified');
                queueRender();
            };
            return pending.then(finish, (e) => {
                valveCommandActive = false;
                valvePriorityUntil = Date.now() + 1200;
                diagLog('valve_command_error', { mode, elapsedMs: Date.now() - startedAt, error: shortError(e) });
                log.warn('exhaust valve: ' + shortError(e));
                queueRender();
            });
        };
        const valveActions = {
            open() { resetMSound(); return valvePress('OPEN')(); },
            close() { resetMSound(); return valvePress('CLOSED')(); },
            oem() { resetMSound(); return valvePress('OEM')(); },
            drive() { resetMSound(); return valvePress('DRIVE')(); },
        };
        function burbleBlockReason() {
            if (!valveReady) return 'DIAGNOSTIC LINK STARTING';
            if (!valveController.armedSetting) return 'CONTROL DISARMED';
            if (!valveController.link || !valveController.link.available) return 'DIAGNOSTIC LINK UNAVAILABLE';
            if (!valveController.bm3Rom) return 'NO SUPPORTED BM3 ROM PROFILE';
            if (valveScanBusy || valveController.tune.busy || valveController.state.busy || valveCommandActive || burbleCommandActive || state.dmeBusy) return 'DIAGNOSTIC LINK BUSY';
            return '';
        }
        async function sendBurbles(value) {
            const blocked = burbleBlockReason();
            if (blocked) {
                showValveNotice('BURBLES NOT SENT · ' + blocked);
                return null;
            }
            burbleCommandActive = true;
            queueRender();
            try {
                const result = await valveController.setTune('burbles', value);
                if (result && result.burblesAccepted === false) {
                    showValveNotice('BURBLES NOT CONFIRMED · ' + (result.error || 'CHECK DME'));
                } else if (result && result.burblesAccepted === true) {
                    showValveNotice(value === null ? 'BURBLES OFF · CONFIRMED BY DME' : 'BURBLES ' + value.toFixed(1) + ' · CONFIRMED BY DME');
                } else {
                    showValveNotice('BURBLES NOT CONFIRMED · CHECK DME');
                }
                return result;
            } catch (e) {
                showValveNotice('BURBLES NOT CONFIRMED · ' + shortError(e));
                return null;
            } finally {
                burbleCommandActive = false;
                valvePriorityUntil = Date.now() + 1200;
                queueRender();
            }
        }
        const burbleActions = {
            back() {
                engineConfigView = 'sections';
                queueRender();
                return render();
            },
            down() { burbleTarget = Math.max(0, Math.round((burbleTarget - 0.5) * 2) / 2); queueRender(); return render(); },
            up() { burbleTarget = Math.min(12, Math.round((burbleTarget + 0.5) * 2) / 2); queueRender(); return render(); },
            apply() { return sendBurbles(burbleTarget); },
            off() { return sendBurbles(null); },
        };
        function toggleMSoundMode() {
            if (mSoundBusy) {
                showValveNotice('M SOUND MODE · COMMAND IN PROGRESS');
                return null;
            }
            const mode = mSoundEnabled ? 'OEM' : 'OPEN';
            if (!valveCanActuate()) return valvePress(mode)();
            if (valveController.state.busy && mode !== 'OEM') return valvePress(mode)();
            mSoundBusy = true;
            if (mSoundEnabled) {
                mSoundEnabled = false;
                queueRender();
                const pending = valvePress('OEM')();
                if (!pending) { mSoundBusy = false; queueRender(); return null; }
                return pending.then(() => {
                    mSoundBusy = false;
                    queueRender();
                });
            }

            mSoundEnabled = true;
            queueRender();
            const pending = valvePress('OPEN')();
            if (!pending) {
                resetMSound();
                mSoundBusy = false;
                queueRender();
                return null;
            }
            return pending.then(() => {
                const state = valveController.state;
                if (state.requested !== 'OPEN' || state.accepted !== true) resetMSound();
                mSoundBusy = false;
                queueRender();
            });
        };
        const sectionActions = {
            exhaust() {
                engineConfigView = 'exhaust';
                queueRender();
            },
            burbles() {
                engineConfigView = 'burbles';
                queueRender();
            },
            dynamic() {
                dscWrite.armed = null;
                engineConfigView = 'dynamic';
                queueRender();
            },
            sections() {
                engineConfigView = 'sections';
                queueRender();
            },
        };
        ui.onClick('BTN_SECTION', sectionActions.sections);
        if (ctx.hideButton) ctx.hideButton('BTN_SECTION');

        const CDS = 'de.bmw.infotainment.vehicle.CDS';
        const CDS2 = 'de.bmw.infotainment.vehicle.CDS2';
        const VEHICLE = 'de.bmw.infotainment.vehicle.Vehicle';
        const VEHICLE2 = 'de.bmw.infotainment.vehicle.Vehicle2';
        const VEHICLE_INFO = 'de.bmw.infrastructure.VehicleInformation';
        const FES = 'de.bmw.infotainment.drivingexcitement.FES';
        const BASIC_DATA = 'de.bmw.infrastructure.analytics.BasicDataSet';
        const ENV = 'de.bmw.infrastructure.EnvironmentalInformation';
        const KOMBI = 'de.bmw.infotainment.KombiIF';
        const PEDAL = 'de.bmw.powertrain.AcceleratorPedal';
        const TPMS = 'de.bmw.infotainment.vehicle.TPMS';
        const TPMS_INTERNAL = 'de.bmw.infotainment.vehicle.TPMSInternalData';
        startWatch(CDS, { statusEngineSpeed2: setRpm, statusEngineTemperature: setEngineTemps,
            statusEngineStatus: setEngineStatus, statusBattery2: setBattery, statusHandBrake: setHandBrake }, { pollMs: 10000 });
        startWatch(BASIC_DATA, { basicDataSet: setGearboxTemp }, { pollMs: 10000 });
        startWatch(CDS2, { statusLongitudinalAccelerationMassCenter: setLongitudinalAcceleration,
            statusPushButtonMSA2: setMsa }, { pollMs: 10000 });
        startWatch(VEHICLE, { statusNewCurrentUnitsStatusExt: setPressureUnits });
        startWatch(VEHICLE2, { statusCarSpeed2: setVehicleSpeed, statusVehicleMass: setMass });
        // The oil dipstick getter often does not emit change notifications. Poll it
        // independently so oil level refreshes without slowing the speed signal used by timers.
        startWatch(VEHICLE2, { statusOilDipstick2: setOilLevel }, { pollMs: 10000 });
        startWatch(ENV, { ExteriorTemperature: setAmbient });
        startWatch(KOMBI, { statusRangeTankStatus: setTank, statusBordcomputerAverage: setBoardAvg }, { pollMs: 10000 });
        startWatch(PEDAL, { AngleAcceleratorPedal: setPedal });
        // TPMS also needs a poll: BMW's own x_call only ever reads these, so a car may never notify them.
        // Front/rear axle tire sizes live on TPMS on this car (not TPMSInternalData).
        startWatch(TPMS, { statusTyrePressure: setTyrePress, statusTyreTemperature: setTyreTemp,
            statusTargetTyrePressure: setTyreTarget, statusTyreState: setTyreState,
            statusFrontAxleTyre: setTyreFront, statusRearAxleTyre: setTyreRear }, { pollMs: 5000 });
        startWatch(TPMS_INTERNAL, { statusWheelTypeChange: setTyreDetection,
            tpmsCalibrationData: setTyreCalibration,
            tpmsErfsActualTireData: setTyreSensor, tpmsInternalLastValues: setTyreLastValues }, { pollMs: 15000 });
        startWatch(VEHICLE_INFO, { statusGearboxDrive: setGearboxStatus, DataPowerTrain2: setGearSelection });
        startWatch(FES, {
            statusActualValueTorque2: setFesTorque,
            statusVehicleDynamicEngine: setFesPercentages,
            statusSwitchDriveDynamicSport2: setFesBoost,
            statusFESVehicleDynamicSwitchHMI: applyDrivingMode,
            statusDSCSwitchHMI: setDsc,
        });
        startDriveModePoll();

        // Boost candidates use read-only ISO-TP/UDS 0x22 and OBD 0x01 requests.
        const readOnlyLink = new ReadOnlyDiag(ctx.signals, log, { gapMs: 80, silentAfter: 3 });
        reader = new DidReader(readOnlyLink, { ecu: dme.ecu });
        async function initDme() {
            if (dmeInit) return dmeInit;
            dmeInit = Promise.resolve().then(() => readOnlyLink.init()).then(() => {
                state.dmeReady = readOnlyLink.ready;
                diagLog('dme_link_ready', { ready: state.dmeReady, error: readOnlyLink.error || null, ecu: dme.ecu });
                return state.dmeReady;
            }).catch((e) => {
                state.dmeReady = false;
                diagLog('dme_link_error', { error: shortError(e) });
                log.warn('DME read-only link: ' + shortError(e));
                return false;
            });
            return dmeInit;
        }

        // CAR DATA tab reads, two per pollDme cycle while the tab is open.
        const dmeExtras = [
            { name: 'iatTemp', cfg: dme.iat || [], unit: 'degC' },
            { name: 'fuelHp', cfg: dme.hpfp || [], unit: 'bar' },
            { name: 'fuelLp', cfg: dme.lpfp || [], unit: 'bar' },
            { name: 'ignTiming', cfg: dme.timing || [], unit: 'deg' },
            { name: 'battVolt', cfg: dme.battVolt || [], unit: 'V' },
            { name: 'boostTargetKpa', cfg: dme.boostTarget || [], unit: 'kPa' },
            { name: 'engineLoad', cfg: dme.loadActual || [], unit: '%' },
            { name: 'dmePower', cfg: dme.dmePower || [], unit: 'kW' },
            { name: 'airFlow', cfg: dme.airFlow || [], unit: 'kg/h' },
            { name: 'throttleValve', cfg: dme.throttleValve || [], unit: '%' },
            { name: 'chargePress', cfg: dme.chargePress || [], unit: 'hPa' },
            { name: 'oilPress', cfg: dme.oilPress || [], unit: 'hPa' },
        ].filter((item) => item.cfg.length > 0);
        const dmeExtrasByView = {
            engineInfo: ['oilPress'],
            powertrain: ['dmePower', 'airFlow', 'throttleValve', 'chargePress'],
            boost: ['iatTemp', 'boostTargetKpa', 'engineLoad'],
            fuel: ['fuelHp', 'fuelLp'],
            ignition: ['ignTiming'],
            electrical: ['battVolt'],
        };
        let dmeExtraIndex = 0, lastDmeExtraView = null;
        let lastDmeCycle = 0;
        let lastEgsTryAt = 0;
        let lastDiagWakeAt = 0;
        // OBD service 06 cylinder misfire counts (MIDs A2..AD), one MID per CAR DATA cycle.
        // Probe A2 directly first: some DMEs answer the monitor but do not publish the A0 list.
        let misfireEcu = null, misfireMids = null, misfireCounts = [], misfireCursor = 0;
        let misfireRetryAt = 0, misfireNextAt = 0, misfireDid = false, misfireScanComplete = false, misfireProbeMid = 0xA3;

        // aref_misfire's tracker: every count rise between readings is an event with the drive's
        // conditions; counts restarting at 0 mark a new drive. Kept across drives on disk.
        const misfireFile = path.join(ctx.dataDir, 'misfires.json');
        const misfireCsv = path.join(ctx.dataDir, 'misfires.csv');
        let misfireSaved = null;
        try { misfireSaved = JSON.parse(fs.readFileSync(misfireFile, 'utf8')); } catch (e) { /* first run */ }
        const misfireTracker = new MisfireTrack.Tracker(misfireSaved);
        let misfireAvg = [], misfireDirty = false;
        const misfireSave = () => {
            if (!misfireDirty) return;
            try {
                fs.writeFileSync(misfireFile, JSON.stringify(misfireTracker.state));
                fs.writeFileSync(misfireCsv, MisfireTrack.csv(misfireTracker.state.events));
                misfireDirty = false;
            } catch (e) { log.warn('misfire save: ' + shortError(e)); }
        };
        const misfireSaveTimer = setInterval(misfireSave, 60000);
        let misfireAvgDirty = false;

        function warmCarDataArt() {
            if (state.stopped) {
                carDataArtTimer = null;
                return;
            }
            const sections = CarDataUi.SECTIONS;
            if (carDataArtIndex >= sections.length) {
                carDataArtTimer = null;
                if (page === 5 && carDataView === 'menu') queueRender();
                return;
            }
            CarDataUi.prepareArt(sections[carDataArtIndex++].key, carDataArtBg);
            if (carDataArtIndex >= sections.length) {
                carDataArtTimer = null;
                if (page === 5 && carDataView === 'menu') queueRender();
                return;
            }
            carDataArtTimer = setTimeout(warmCarDataArt, 40);
        }

        function scheduleCarDataArtWarmup(bg) {
            if (carDataArtBg !== bg) {
                carDataArtBg = bg;
                carDataArtIndex = 0;
            }
            if (carDataArtTimer || carDataArtIndex >= CarDataUi.SECTIONS.length) return;
            // Prepare the badges in short slices while the app is already
            // displaying its first page, then reveal the complete menu together.
            carDataArtTimer = setTimeout(warmCarDataArt, 0);
        }

        // Conditions snapshot for a misfire event (aref_misfire ctx): what the car was doing.
        function misfireCtx() {
            const n = Date.now();
            return {
                rpm: fresh(state.rpm, n) ? state.rpm.value : null,
                speed: fresh(state.speed, n) ? state.speed.value : null,
                coolant: cdNum('coolantTemp'),
                oil: cdNum('oilTemp'),
                gear: vehicleGear || null,
                torque: state.torqueFes && finite(state.torqueFes.value) ? state.torqueFes.value : null,
                mode: drivingMode,
            };
        }

        async function pollMisfire(now) {
            const cfg = dme.misfire || {};
            const set = (value, status) => {
                // A missed reply must not erase a recent, good count set.
                if (status === 'unavailable' && state.misfire && state.misfire.status === 'live' &&
                    Date.now() - state.misfire.at <= 120000) return;
                state.misfire = { raw: value, value, unit: 'counts', source: 'DME / OBD service 06', at: Date.now(), status };
                // Every rise is a logged event with the drive's conditions; a count back at 0 is a
                // new drive. Only feed a complete set (every cylinder answered at least once).
                if (status === 'live' && Array.isArray(value) && value.some((v) => v !== null)) {
                    try {
                        const ev = misfireTracker.feed(value, Date.now(), misfireCtx(), misfireAvg);
                        if (ev.length || misfireAvgDirty) { misfireDirty = true; misfireAvgDirty = false; }
                        if (ev.length) log.info('misfire: ' + ev.map((e) => 'cyl' + e.cyl + '+' + e.n).join(', '));
                    } catch (e) { log.warn('misfire track: ' + shortError(e)); }
                }
                if (page === 5 && carDataView === 'engineInfo') queueRender();
            };
            if (!misfireMids || !misfireMids.length) {
                if (now < misfireRetryAt) return;
                const ownEcu = cfg.ecu == null ? dme.ecu : cfg.ecu;
                const units = cfg.ecu == null && ownEcu !== 0x13 ? [ownEcu, 0x13] : [ownEcu];
                let first = null;
                // Ask the first cylinder directly instead of relying on MID A0 being advertised.
                for (const ecu of units) {
                    try {
                        const rows = await reader.monitor(ecu, 0xA2, false);
                        if (rows && rows.length) { first = { ecu, did: false, rows }; break; }
                    } catch (e) { /* try the other engine unit / UDS form */ }
                }
                // Some BMW DMEs expose the same monitor only as UDS F6A2.
                if (!first) {
                    for (const ecu of units) {
                        try {
                            const rows = await reader.monitor(ecu, 0xA2, true);
                            if (rows && rows.length) { first = { ecu, did: true, rows }; break; }
                        } catch (e) { /* keep checking the configured engine units */ }
                    }
                }
                if (!first) {
                    set(null, 'unavailable');
                    misfireMids = null;
                    misfireEcu = null;
                    misfireRetryAt = Date.now() + 300000;
                    return;
                }

                misfireEcu = first.ecu;
                misfireDid = first.did;
                let supported = null;
                try { supported = await reader.supported(misfireEcu, 0xA0, misfireDid); } catch (e) { /* use direct MID probing */ }
                const advertised = (supported || []).filter((mid) => mid >= 0xA2 && mid <= 0xAD).slice(0, 12);
                if (advertised.length) {
                    misfireMids = advertised.indexOf(0xA2) >= 0 ? advertised : [0xA2].concat(advertised);
                    misfireCounts = misfireMids.map(() => null);
                    misfireScanComplete = true;
                } else {
                    // Keep scanning contiguous cylinder monitors until the DME explicitly refuses one.
                    misfireMids = [0xA2];
                    misfireCounts = [null];
                    misfireProbeMid = 0xA3;
                    misfireScanComplete = false;
                }
                misfireCursor = 0;
                const tid = parseInt(cfg.tid || '0C', 16);
                const row = first.rows.find((item) => item.tid === tid) || first.rows[0];
                const avgRow = first.rows.find((item) => item.tid === 0x0B);
                if (avgRow && avgRow.value < 65535) { misfireAvg[misfireMids.indexOf(0xA2)] = avgRow.value; misfireAvgDirty = true; }
                if (row && row.value < 65535) {
                    misfireCounts[misfireMids.indexOf(0xA2)] = row.value;
                    set(misfireCounts.slice(), 'live');
                }
                misfireRetryAt = 0;
                return;
            }

            if (now < misfireNextAt) return;
            misfireNextAt = 0;
            const probing = !misfireScanComplete;
            const mid = probing ? misfireProbeMid : misfireMids[misfireCursor++ % misfireMids.length];
            if (mid > 0xAD) { misfireScanComplete = true; return; }
            let rows;
            try { rows = await reader.monitor(misfireEcu, mid, misfireDid); }
            catch (e) {
                rows = null;
            }
            if (!rows || !rows.length) {
                const raw = reader.raws[reader.monitorKey(misfireEcu, mid, misfireDid)];
                if (probing && raw && (/^NRC/.test(raw.why) || raw.why === 'no test results')) {
                    misfireScanComplete = true;
                    return;
                }
                // A timeout is a missed sample, not evidence that the cylinder has no monitor.
                misfireNextAt = Date.now() + 30000;
                return;
            }
            const tid = parseInt(cfg.tid || '0C', 16);
            const row = rows.find((item) => item.tid === tid) || rows[0];
            const avgRow = rows.find((item) => item.tid === 0x0B);
            if (!row) return;
            if (probing) {
                misfireMids.push(mid);
                misfireCounts.push(null);
                misfireProbeMid++;
            }
            if (avgRow && avgRow.value < 65535) { misfireAvg[misfireMids.indexOf(mid)] = avgRow.value; misfireAvgDirty = true; }
            if (row.value < 65535) misfireCounts[misfireMids.indexOf(mid)] = row.value;
            if (misfireCounts.some((value) => value !== null)) set(misfireCounts.slice(), 'live');
        }
        function wakeSilentDiagUnits(now) {
            if (!readOnlyLink || !fresh(state.rpm, now) || state.rpm.value < 500 || now - lastDiagWakeAt < 15000) return;
            const units = new Set([dme.ecu]);
            Object.keys(dme).forEach((key) => {
                const items = dme[key];
                if (Array.isArray(items)) items.forEach((item) => {
                    if (item && finite(item.ecu)) units.add(item.ecu);
                });
                else if (items && finite(items.ecu)) units.add(items.ecu);
            });
            if (dme.misfire && dme.misfire.ecu == null && dme.ecu !== 0x13) units.add(0x13);
            const silent = Array.from(units).filter((ecu) => readOnlyLink.silent(ecu));
            if (!silent.length) return;
            silent.forEach((ecu) => readOnlyLink.wake(ecu));
            lastDiagWakeAt = now;
            diagLog('dme_targets_woken', { ecus: silent, engineRpm: state.rpm.value });
        }
        async function pollDme() {
            const now = Date.now();
            if (state.stopped || state.dmeBusy || settings.get('demo') === 'on' ||
                settings.get('readDmeCandidates') !== true || valveCommandActive || burbleCommandActive || valveScanBusy ||
                valveController.state.busy || valveController.tune.busy || now < valvePriorityUntil) return;
            if (!(page === 5 && carDataView === 'menu')) wakeSilentDiagUnits(now);
            const gearbox = state.gearboxTemp;
            const gearboxSignalFresh = gearbox && gearbox.status === 'live' && finite(gearbox.value) &&
                now - gearbox.at <= GEARBOX_STALE_MS;
            const needsEgsTemp = (page === 0 || page === 6 || (page === 5 && carDataView === 'drivetrain')) &&
                (dme.egs || []).length > 0 && !gearboxSignalFresh &&
                now - lastEgsTryAt >= 15000;
            const activeCarData = page === 5 && carDataView !== 'menu';
            // Selected CAR DATA sections can read engine-off values too. The
            // static section menu does not need to keep the diagnostic bus busy.
            if ((!fresh(state.rpm, now) || state.rpm.value < 500) && !activeCarData && !needsEgsTemp) return;
            if (now - lastDmeCycle < DME_POLL_MS) return;
            const boostSource = settings.get('boostSource') || 'auto';
            const pageNeedsDmeBoost = page !== 5 || carDataView === 'boost';
            const needsDmeBoost = pageNeedsDmeBoost && (boostSource === 'dme' ||
                (boostSource === 'auto' && !(fresh(state.boostFes, now) && fesBoostTrusted)) ||
                (page === 5 && carDataView === 'boost' && !(fresh(state.boostDme, now))));
            const extraNames = dmeExtrasByView[carDataView] || [];
            const activeExtras = page === 5 ? dmeExtras.filter((item) => extraNames.indexOf(item.name) >= 0) : [];
            const wantExtras = activeExtras.length > 0;
            if ((!needsDmeBoost || boostSource === 'fes') && !wantExtras && !needsEgsTemp) return;
            const extraView = page === 5 ? carDataView : null;
            if (extraView !== lastDmeExtraView) {
                dmeExtraIndex = 0;
                lastDmeExtraView = extraView;
            }
            lastDmeCycle = now;
            state.dmeBusy = true;
            try {
                if (!await initDme()) return;
                if (state.stopped) return;
                // M Vitals refreshes barometric pressure before reading absolute boost.
                if (Date.now() - state.baroAt >= 60000) {
                    state.baroAt = Date.now();
                    const baroKpa = await reader.value('baro', dme.baro);
                    if (baroKpa !== null) { state.baroKpa = baroKpa; state.baroMeasured = true; }
                    const baroAttempts = dme.baro.map((c) => {
                        const r = reader.raws[reader.key(c)] || {};
                        return { candidate: DidReader.label(c), ok: !!r.ok, reason: r.why || '', raw: r.bytes || '' };
                    });
                    diagLog('dme_baro', { kpa: state.baroKpa, measured: state.baroMeasured, attempts: baroAttempts });
                }
                if (needsDmeBoost && boostSource !== 'fes') {
                    const absoluteKpa = await reader.value('boost', dme.boost);
                    const candidate = dme.boost[reader.pick.boost || 0];
                    const result = candidate && reader.raws[reader.key(candidate)] || {};
                    const attempts = dme.boost.map((c) => {
                        const r = reader.raws[reader.key(c)] || {};
                        return { candidate: DidReader.label(c), ok: !!r.ok, reason: r.why || '', raw: r.bytes || '' };
                    });
                    if (absoluteKpa === null) {
                        updateMetric('boostDme', attempts, null, 'bar', 'DME/OBD boost candidates', 'unavailable');
                        diagLog('dme_boost_unavailable', { ecu: dme.ecu, attempts });
                    } else {
                        const value = Calc.dmeBoostBar(absoluteKpa, state.baroKpa);
                        if (finite(value)) {
                            if (firstDmeBoost === null) firstDmeBoost = value;
                            else if (Math.abs(value - firstDmeBoost) >= 0.03) dmeBoostTrusted = true;
                        }
                        const source = candidate ? 'DME ' + DidReader.label(candidate) : 'DME/OBD';
                        updateMetric('boostDme', result.bytes || attempts, value, 'bar', source, value === null ? 'invalid' : 'live');
                        diagLog('dme_boost_payload', {
                            ecu: dme.ecu, candidate: candidate ? DidReader.label(candidate) : null,
                            raw: result.bytes || '', absoluteKpa, baroKpa: state.baroKpa,
                            baroMeasured: state.baroMeasured, boostBar: value, moving: dmeBoostTrusted,
                        });
                    }
                }
                // The EGS provides gearbox oil temperature on cars where the
                // instrument cluster's BasicDataSet does not publish it.
                if (needsEgsTemp && !state.stopped) {
                    lastEgsTryAt = Date.now();
                    const value = await reader.value('egs', dme.egs);
                    const candidate = dme.egs[reader.pick.egs || 0];
                    if (value === null) {
                        const attempts = dme.egs.map((c) => {
                            const r = reader.raws[reader.key(c)] || {};
                            return { ecu: c.ecu == null ? dme.ecu : c.ecu, candidate: DidReader.label(c), reason: r.why || '', raw: r.bytes || '' };
                        });
                        diagLog('gearbox_egs_unavailable', { attempts });
                    } else {
                        updateMetric('gearboxTemp', value, value, 'degC', 'EGS ' + DidReader.label(candidate), 'live');
                        diagLog('gearbox_egs_value', { ecu: candidate && candidate.ecu, candidate: candidate && DidReader.label(candidate), value });
                    }
                    if (state.stopped) return;
                }
                // Read only the active CAR DATA section's values, one request
                // per cycle, so opening the static menu never floods the ECU.
                if (wantExtras && !state.stopped) {
                    const item = activeExtras[dmeExtraIndex % activeExtras.length];
                    dmeExtraIndex++;
                    const value = await reader.value(item.name, item.cfg);
                    // Keep the last valid DME sample through a transient no-reply. cdNum()
                    // expires it after CD_STALE, so the UI does not flash a dash each poll.
                    if (value !== null || !state[item.name] || state[item.name].status !== 'live') {
                        updateMetric(item.name, value, value, item.unit, 'DME ' + item.name,
                            value === null ? 'invalid' : 'live');
                    }
                    if (state.stopped) return;
                    // ENGINE INFO also asks for the cylinder misfire counts — one MID a cycle.
                    if (carDataView === 'engineInfo') await pollMisfire(now);
                }
            } catch (e) {
                diagLog('dme_poll_error', { error: shortError(e) });
                log.warn('DME poll: ' + shortError(e));
            } finally {
                state.dmeBusy = false;
            }
        }

        function selectTorque(now) {
            const value = heldNum('torqueFes');
            if (finite(value)) return { value, source: 'BMW SPORT SIGNAL' };
            return null;
        }

        function boostValue(now) {
            const source = settings.get('boostSource') || 'auto';
            const fes = heldNum('boostFes'), dmeValue = heldNum('boostDme');
            if (source !== 'dme' && finite(fes) && (source === 'fes' || fesBoostTrusted)) {
                return { value: fes, approximate: true, source: 'BMW SPORT DISPLAY' };
            }
            if (source !== 'fes' && finite(dmeValue) && (source === 'dme' || dmeBoostTrusted)) {
                return { value: dmeValue, approximate: !state.baroMeasured, source: state.boostDme.source };
            }
            return null;
        }

        function current(demo) {
            const now = Date.now();
            const maxPowerKw = settings.get('maxPower') || 215;
            const powerUnit = settings.get('powerUnit') || 'hp';
            const powerFor = (percent, torque, rpm) => {
                const powerKw = Calc.powerKw(percent, torque, rpm, settings.get('powerSource') || 'sport', maxPowerKw);
                return powerKw ? {
                    kw: powerKw.kw, value: Calc.powerValue(powerKw.kw, powerUnit),
                    unit: Calc.powerUnit(powerUnit), source: powerKw.source,
                    approximate: powerKw.approximate,
                } : null;
            };
            if (demo) {
                const sec = now / 1000;
                const rpm = 1800 + 5200 * (0.5 + 0.5 * Math.sin(sec * 0.34));
                const torque = 200 + 80 * Math.max(0, Math.sin(sec * 0.34 - 0.7));
                const demoPowerKw = Math.max(0, torque * rpm / 9549);
                const powerPct = Math.min(100, demoPowerKw / maxPowerKw * 100);
                const boost = { value: 0.3 + 1.2 * Math.max(0, Math.sin(sec * 0.34)), approximate: true, source: 'DEMO' };
                const result = {
                    demo: true, rpm, torque, torqueSource: 'DEMO', power: powerFor(powerPct, torque, rpm), powerUnit,
                    powerPct, torquePct: Math.min(100, torque / 7),
                    boost,
                    oil: 92 + 6 * Math.sin(sec * 0.11), gearbox: 84 + 5 * Math.sin(sec * 0.13 + 1.1),
                };
                result.peaks = peakValues('demo', result, now);
                return result;
            }
            const engineOff = cdText('engineState') === 'ENGINE OFF';
            const rpm = engineOff ? 0 : heldNum('rpm');
            const tq = engineOff ? { value: 0, source: 'ENGINE OFF' } : selectTorque(now);
            const powerPct = engineOff ? 0 : heldNum('powerPct');
            const torque = tq ? tq.value : null;
            const gear = vehicleGearAt && now - vehicleGearAt <= CD_STALE ? vehicleGear : null;
            const speed = heldNum('speed');
            const result = {
                demo: false, rpm, torque, torqueSource: tq ? tq.source : null,
                power: powerFor(powerPct, torque, rpm), powerUnit,
                powerPct,
                speed: finite(speed) ? speed : gear === 'P' ? 0 : null,
                gear,
                torquePct: engineOff ? 0 : heldNum('torquePct'),
                boost: engineOff ? { value: 0, approximate: false, source: 'ENGINE OFF' } : boostValue(now),
                oil: heldNum('oilTemp'),
                gearbox: heldNum('gearboxTemp'),
            };
            result.peaks = peakValues('live', result, now);
            return result;
        }

        /* ---- CAR DATA tab: five headline values per section page ----
           Numbers and texts only surface while their metric is fresh: engine-bus
           values use FRESH_MS, slow cluster/TPMS values use CD_STALE. Anything
           older or missing renders as an em dash rather than a made-up number. */
        function cdNum(name, maxAge) {
            const m = state[name];
            const ageLimit = finite(maxAge) ? maxAge : metricStaleMs(name);
            return m && m.status === 'live' && Date.now() - m.at <= ageLimit && finite(m.value) ? m.value : null;
        }
        function cdText(name, maxAge) {
            const m = state[name];
            return m && m.status === 'live' && Date.now() - m.at <= (maxAge || CD_STALE) && m.text ? m.text : null;
        }
        function heldNum(name) { return cdNum(name, metricStaleMs(name)); }
        function cdFast(name) { return cdNum(name, FRESH_MS); }
        const cdu = (v, digits, unit) => finite(v) ? formatNumber(v, digits) + ' ' + unit : null;
        const cdt = (v) => v === null || v === undefined ? null : String(v);

        /* ---- WARMUP page: ready-in estimates, status stamp, ribbon rows ---- */
        function warmupEtaText(e) {
            if (e.state === 'ready') return { v: 'READY', c: '#2fd27a' };
            if (e.state === 'off') return { v: 'ENGINE OFF', c: '#8c94a0' };
            if (e.state === 'stalled') return { v: 'NOT WARMING', c: '#ffb31a' };
            if (e.state === 'warming') return { v: e.min > 60 ? '>60 min' : '~' + Math.max(1, Math.round(e.min)) + ' min' };
            return { v: null };
        }

        function warmupView(demo, s) {
            const now = Date.now();
            const d = {
                rpm: s.rpm, speed: s.speed,
                oil: demo ? 82 + 10 * Math.sin(now / 50000) : cdNum('oilTemp'),
                coolant: demo ? 86 + 6 * Math.sin(now / 50000 + 0.6) : cdNum('coolantTemp'),
                gearbox: demo ? 74 + 6 * Math.sin(now / 50000 + 1.2) : cdNum('gearboxTemp'),
            };
            const warm = {
                oil: settings.get('warmOil') || 90,
                coolant: settings.get('warmCoolant') || 80,
                gearbox: settings.get('warmGearbox') || 70,
            };
            const etas = {
                oil: warmup.eta('oil', d.oil, warm.oil, d),
                coolant: warmup.eta('coolant', d.coolant, warm.coolant, d),
                gearbox: warmup.eta('gearbox', d.gearbox, warm.gearbox, d),
            };
            const cd = warmup.cooldown();
            const cooling = settings.get('warmupCooldown') !== false && cd.needS > 0;
            const gbCold = finite(d.gearbox) && d.gearbox < warm.gearbox;
            const gbHot = finite(d.gearbox) && d.gearbox > 125;
            const ready = finite(d.oil) && d.oil >= warm.oil && !gbCold;
            const hot = finite(d.oil) && d.oil > 125;
            let status;
            if (!finite(d.oil)) status = { text: 'NO OIL TEMP', kind: 'dim' };
            else if (hot) status = { text: 'OIL HOT — EASE OFF', kind: 'crit' };
            else if (gbHot) status = { text: 'GEARBOX HOT — EASE OFF', kind: 'crit' };
            else if (cooling) status = { text: cd.done ? 'READY — OK TO SWITCH OFF' : 'TURBO TIMER', kind: cd.done ? 'ready' : 'warn' };
            else if (ready) status = { text: 'READY', kind: 'ready' };
            else if (d.oil >= warm.oil && gbCold) status = { text: 'GEARBOX WARMING UP', kind: 'warn' };
            else if (d.oil >= warm.oil - 20) status = { text: 'WARMING UP', kind: 'warn' };
            else status = { text: 'COLD', kind: 'cold' };

            const lim = warmup.limit(d.oil);
            const eo = warmupEtaText(etas.oil), ec = warmupEtaText(etas.coolant), eg = warmupEtaText(etas.gearbox);
            const rows = [
                { label: 'OIL READY IN', value: eo.v, color: eo.c, lit: etas.oil.state === 'ready' },
                { label: 'COOLANT READY IN', value: ec.v, color: ec.c, lit: etas.coolant.state === 'ready' },
                { label: 'GEARBOX READY IN', value: eg.v, color: eg.c, lit: etas.gearbox.state === 'ready' },
                { label: 'SAFE REV LIMIT', value: lim ? formatNumber(lim, 0) + ' rpm' : null,
                    color: ready ? '#2fd27a' : undefined, lit: ready },
                { label: 'TURBO TIMER', value: cooling ? (cd.done ? 'DONE' : Math.ceil(cd.left) + ' s') : 'OFF',
                    color: cd.done ? '#2fd27a' : cooling ? '#ffb31a' : '#8c94a0', lit: cooling || cd.done },
            ];
            return {
                temps: { oil: d.oil, coolant: d.coolant, gearbox: d.gearbox }, warm,
                status, rows, trend: warmup.trend(), coldStarts: warmup.coldStarts(),
                cooldown: { active: cooling, left: cd.left, done: cd.done, needS: cd.needS },
            };
        }

        function carDataRows(view, demo, s) {
            const now = Date.now();
            if (demo) {
                const sec = now / 1000;
                const w = (a, b, f) => a + b * Math.sin(sec * f);
                const demoRow = {
                    engineInfo: [
                        { label: 'MISFIRES', value: '0 · 0 · 0 · 0 · 0 · 0' },
                        { label: 'COOLANT TEMP', value: '94 °C', detail: 'thermostat band' },
                        { label: 'ENGINE OIL TEMP', value: cdu(s.oil, 0, '°C') },
                        { label: 'OIL LEVEL', value: 'FULL' },
                        { label: 'OIL PRESSURE', value: cdu(w(2.6, 1.1, 0.5), 1, 'bar') },
                    ],
                    powertrain: [
                        { label: 'ENGINE POWER · DME', value: s.power ? cdu(s.power.value, 0, s.power.unit) : null, detail: 'engine unit · effective' },
                        { label: 'AIR FLOW', value: cdu(200 + 420 * (0.5 + 0.5 * Math.sin(sec * 0.34)), 0, 'kg/h'), detail: 'mass through throttle' },
                        { label: 'THROTTLE VALVE', value: cdu(32 + 30 * Math.max(0, Math.sin(sec * 0.34)), 0, '%'), detail: 'actual valve angle' },
                        { label: 'CHARGE PRESSURE', value: cdu(1.05 + 1.35 * Math.max(0, Math.sin(sec * 0.34)), 2, 'bar'), detail: 'before throttle · absolute' },
                        { label: 'THROTTLE PEDAL', value: cdu(30 + 25 * Math.max(0, Math.sin(sec * 0.34)), 0, '%'), detail: 'driver input' },
                    ],
                    boost: [
                        { label: 'BOOST PRESSURE', value: s.boost ? cdu(s.boost.value, 2, 'bar') : null },
                        { label: 'BOOST TARGET', value: cdu(0.4 + 0.9 * Math.max(0, Math.sin(sec * 0.34)), 2, 'bar') },
                        { label: 'BOOST PEAK', value: '1.62 bar' },
                        { label: 'INTAKE AIR TEMP', value: cdu(w(27, 4, 0.08), 0, '°C') },
                        { label: 'ENGINE LOAD', value: cdu(45 + 30 * Math.max(0, Math.sin(sec * 0.34)), 0, '%') },
                    ],
                    fuel: [
                        { label: 'FUEL IN TANK', value: '41.2 l' },
                        { label: 'RANGE', value: '486 km' },
                        { label: 'AVG CONSUMPTION', value: '9.8 l/100km' },
                        { label: 'RAIL PRESSURE', value: cdu(w(121, 14, 0.4), 0, 'bar') },
                        { label: 'LOW PRESSURE PUMP', value: cdu(w(5.1, 0.4, 0.5), 1, 'bar') },
                    ],
                    ignition: [
                        { label: 'ENGINE STATE', value: 'RUNNING' },
                        { label: 'IGNITION TIMING', value: cdu(w(12.5, 4, 0.6), 1, '°'), detail: 'BTDC · cyl 1' },
                        { label: 'AUTO START-STOP', value: 'OFF' },
                        { label: 'FUEL IN TANK', value: '41.2 l' },
                        { label: 'RANGE', value: '486 km' },
                    ],
                    drivetrain: [
                        { label: 'GEAR', value: s.gear || 'D3' },
                        { label: 'GEARBOX OIL TEMP', value: cdu(s.gearbox, 0, '°C') },
                        { label: 'XDRIVE REAR SPLIT', value: settings.get('drivetrainType') === 'rwd' ? 'NOT SUPPORTED ON RWD' : cdu(w(72, 12, 0.3), 0, '%'), detail: 'rear axle torque' },
                        { label: 'ENGINE RPM', value: cdu(s.rpm, 0, 'rpm'), detail: 'crankshaft speed' },
                        { label: 'ENGINE TORQUE', value: cdu(s.torque, 0, 'Nm'), detail: 'BMW engine signal' },
                    ],
                    electrical: [
                        { label: 'BATTERY VOLTAGE', value: cdu(w(14.1, 0.4, 0.2), 1, 'V') },
                        { label: 'BATTERY CHARGE', value: '86 %' },
                        { label: 'AUTO START-STOP', value: 'OFF' },
                        { label: 'PARKING BRAKE', value: 'RELEASED' },
                        { label: 'ODOMETER', value: '47,812 km' },
                    ],
                    tyres: [
                        { label: 'FRONT LEFT', value: '2.42 bar (26 °C)' },
                        { label: 'FRONT RIGHT', value: '2.41 bar (26 °C)' },
                        { label: 'REAR LEFT', value: '2.55 bar (27 °C)' },
                        { label: 'REAR RIGHT', value: '2.56 bar (28 °C)' },
                        { label: 'DSC MODE', value: 'ON' },
                    ],
                    tyresMore: [
                        { label: 'RECOMMENDED PRESSURE · FRONT LEFT', value: '2.4 bar' },
                        { label: 'RECOMMENDED PRESSURE · FRONT RIGHT', value: '2.4 bar' },
                        { label: 'RECOMMENDED PRESSURE · REAR LEFT', value: '2.6 bar' },
                        { label: 'RECOMMENDED PRESSURE · REAR RIGHT', value: '2.6 bar' },
                        { label: 'FITTED TIRES', value: '245/40R18 / 275/35R19' },
                        { label: 'TIRE DETECTION / TPMS RESET', value: 'Wheels found · Passed' },
                    ],
                };
                return demoRow[view] || [];
            }
            const gear = vehicleGearAt && now - vehicleGearAt <= CD_STALE ? vehicleGear : null;
            const boost = boostValue(now);
            const baro = finite(state.baroKpa) ? state.baroKpa : 101.3;
            const targetKpa = cdNum('boostTargetKpa');
            const tyreWheel = (pKey, tKey) => {
                const p = cdNum(pKey), tt = cdNum(tKey);
                if (!finite(p)) return null;
                return finite(tt) ? formatNumber(p, 2) + ' bar (' + formatNumber(tt, 0) + ' °C)'
                    : formatNumber(p, 2) + ' bar';
            };
            const rows = {
                engineInfo: [
                    { label: 'MISFIRES', value: (() => {
                        const m = state.misfire;
                        if (!m || m.status !== 'live' || !Array.isArray(m.value) || now - m.at > CD_STALE) return null;
                        if (m.value.length && m.value.every((v) => v === 0)) return '0';
                        return m.value.map((v) => (v === null || v === undefined ? '-' : String(v))).join(' · ');
                    })(), detail: (() => {
                        const mt = misfireTracker.state;
                        const parts = [];
                        const drive = misfireTracker.driveTotal();
                        const allTime = MisfireTrack.sum(mt.totals);
                        if (drive > 0 || allTime > 0) parts.push('drive ' + drive + ' · all-time ' + allTime);
                        const last = mt.events.length ? mt.events[mt.events.length - 1] : null;
                        if (last) {
                            const c = last.ctx || {};
                            const bits = [last.cyl ? 'cyl ' + last.cyl : null, c.rpm ? Math.round(c.rpm) + ' rpm' : null,
                                c.speed ? Math.round(c.speed) + ' km/h' : null, c.gear || null, c.mode || null].filter(Boolean);
                            if (bits.length) parts.push('last ' + bits.join(' @ '));
                        }
                        const worst = misfireTracker.worst();
                        if (worst) parts.push('worst cyl ' + worst);
                        if (misfireAvg.some((v) => typeof v === 'number')) parts.push('avg10 ' + misfireAvg.map((v) => (v === null || v === undefined ? '-' : formatNumber(v, 1))).join(' · '));
                        return parts.join(' | ') || '';
                    })() },
                    { label: 'COOLANT TEMP', value: cdu(cdNum('coolantTemp'), 0, '°C') },
                    { label: 'ENGINE OIL TEMP', value: cdu(cdNum('oilTemp'), 0, '°C') },
                    { label: 'OIL LEVEL', value: cdt(cdText('oilLevel')) },
                    { label: 'OIL PRESSURE', value: (() => {
                        const op = cdNum('oilPress');
                        return finite(op) ? cdu(op / 1000, 1, 'bar') : null;
                    })() },
                ],
                powertrain: [
                    { label: 'ENGINE POWER · DME', value: (() => {
                        const kw = cdNum('dmePower');
                        return finite(kw) ? cdu(Calc.powerValue(kw, settings.get('powerUnit') || 'hp'), 0, Calc.powerUnit(settings.get('powerUnit') || 'hp')) : null;
                    })(), detail: 'engine unit · effective' },
                    { label: 'AIR FLOW', value: cdu(cdNum('airFlow'), 0, 'kg/h'), detail: 'mass through throttle' },
                    { label: 'THROTTLE VALVE', value: cdu(cdNum('throttleValve'), 0, '%'), detail: 'actual valve angle' },
                    { label: 'CHARGE PRESSURE', value: cdu(cdNum('chargePress') / 1000, 2, 'bar'), detail: 'before throttle · absolute' },
                    { label: 'THROTTLE PEDAL', value: cdu(cdFast('pedalPct'), 0, '%'), detail: 'driver input' },
                ],
                boost: [
                    { label: 'BOOST PRESSURE', value: boost ? (boost.approximate ? '~' : '') + cdu(boost.value, 2, 'bar') : null, detail: boost ? boost.source : '' },
                    { label: 'BOOST TARGET', value: finite(targetKpa) ? (state.baroMeasured ? '' : '~') + cdu((targetKpa - baro) / 100, 2, 'bar') : null },
                    { label: 'BOOST PEAK', value: finite(cdNum('boostPeak')) ? '~' + cdu(cdNum('boostPeak'), 2, 'bar') : null, detail: 'since ignition on · Sport Display scale' },
                    { label: 'INTAKE AIR TEMP', value: cdu(cdNum('iatTemp'), 0, '°C') },
                    { label: 'ENGINE LOAD', value: cdu(cdNum('engineLoad'), 0, '%') },
                ],
                fuel: [
                    { label: 'FUEL IN TANK', value: cdu(cdNum('tankLitres'), 1, 'l') },
                    { label: 'RANGE', value: cdu(cdNum('rangeKm'), 0, 'km') },
                    { label: 'AVG CONSUMPTION', value: cdt(cdText('avgCons')) },
                    { label: 'RAIL PRESSURE', value: cdu(cdNum('fuelHp'), 0, 'bar') },
                    { label: 'LOW PRESSURE PUMP', value: cdu(cdNum('fuelLp'), 1, 'bar') },
                ],
                ignition: [
                    { label: 'ENGINE STATE', value: cdt(cdText('engineState')) },
                    { label: 'IGNITION TIMING', value: cdu(cdNum('ignTiming'), 1, '°'), detail: 'BTDC · cyl 1' },
                    { label: 'AUTO START-STOP', value: cdt(cdText('msaState')) },
                    { label: 'FUEL IN TANK', value: cdu(cdNum('tankLitres'), 1, 'l') },
                    { label: 'RANGE', value: cdu(cdNum('rangeKm'), 0, 'km') },
                ],
                drivetrain: [
                    { label: 'GEAR', value: cdt(gear) },
                    { label: 'GEARBOX OIL TEMP', value: cdu(cdNum('gearboxTemp'), 0, '°C') },
                    { label: 'XDRIVE REAR SPLIT', value: settings.get('drivetrainType') === 'rwd'
                        ? 'NOT SUPPORTED ON RWD' : cdu(cdNum('splitRear'), 0, '%'), detail: 'rear axle torque' },
                    { label: 'ENGINE RPM', value: cdu(s.rpm, 0, 'rpm'), detail: 'crankshaft speed' },
                    { label: 'ENGINE TORQUE', value: cdu(s.torque, 0, 'Nm'), detail: 'BMW engine signal' },
                ],
                electrical: [
                    { label: 'BATTERY VOLTAGE', value: cdu(cdNum('battVolt'), 1, 'V') },
                    { label: 'BATTERY CHARGE', value: cdu(cdNum('battCharge'), 0, '%') },
                    { label: 'AUTO START-STOP', value: cdt(cdText('msaState')) },
                    { label: 'PARKING BRAKE', value: cdt(cdText('handBrake')) },
                    { label: 'ODOMETER', value: cdu(cdNum('odoKm'), 0, 'km') },
                ],
                tyres: [
                    { label: 'FRONT LEFT', value: tyreWheel('tyrePFL', 'tyreTFL') },
                    { label: 'FRONT RIGHT', value: tyreWheel('tyrePFR', 'tyreTFR') },
                    { label: 'REAR LEFT', value: tyreWheel('tyrePRL', 'tyreTRL') },
                    { label: 'REAR RIGHT', value: tyreWheel('tyrePRR', 'tyreTRR') },
                    { label: 'DSC MODE', value: tyreExtra.dsc ? tyreExtra.dsc.state.toUpperCase() : null,
                        detail: 'traction control · as the cluster shows it' },
                ],
                tyresMore: [
                    { label: 'RECOMMENDED PRESSURE · FRONT LEFT', value: finite(cdNum('tyrePtFL'))
                        ? formatNumber(cdNum('tyrePtFL'), 1) + ' bar' : 'WAITING FOR TPMS',
                        detail: (() => { const ts = tyreExtra.tyreState; return ts ? [ts.loading, ts.season, ts.mode].filter(Boolean).join(' · ') : ''; })() },
                    { label: 'RECOMMENDED PRESSURE · FRONT RIGHT', value: finite(cdNum('tyrePtFR'))
                        ? formatNumber(cdNum('tyrePtFR'), 1) + ' bar' : 'WAITING FOR TPMS' },
                    { label: 'RECOMMENDED PRESSURE · REAR LEFT', value: finite(cdNum('tyrePtRL'))
                        ? formatNumber(cdNum('tyrePtRL'), 1) + ' bar' : 'WAITING FOR TPMS' },
                    { label: 'RECOMMENDED PRESSURE · REAR RIGHT', value: finite(cdNum('tyrePtRR'))
                        ? formatNumber(cdNum('tyrePtRR'), 1) + ' bar' : 'WAITING FOR TPMS' },
                    { label: 'FITTED TIRES', value: (() => {
                        const f = tyreExtra.frontTire, r = tyreExtra.rearTire;
                        if (!f && !r) return 'WAITING FOR TPMS';
                        if (f && r && f.size === r.size) return f.size;
                        return (f ? f.size : '--') + ' / ' + (r ? r.size : '--');
                    })(), detail: (() => {
                        const f = tyreExtra.frontTire, r = tyreExtra.rearTire;
                        const parts = [];
                        if (f && r && f.text !== r.text) parts.push('F ' + f.text + ' · R ' + r.text);
                        else if (f) parts.push(f.text);
                        const st = tyreExtra.sensorTire;
                        if (st && st.tire) parts.push('sensors say ' + st.tire.size + (st.mounted ? ' (mounted)' : ''));
                        else if (st) parts.push('sensors: ' + st.state);
                        return parts.join(' | ');
                    })() },
                    { label: 'TIRE DETECTION / TPMS RESET', value: (() => {
                        const detection = tyreExtra.detection ? tyreExtra.detection.title : 'WAITING FOR TPMS';
                        const calibration = tyreExtra.calibration ? tyreExtra.calibration.result : 'RESET UNKNOWN';
                        return detection + ' · ' + calibration;
                    })(), detail: (() => {
                        const c = tyreExtra.calibration;
                        return c ? c.type + (c.mileage ? ' · ' + Math.round(c.mileage).toLocaleString('en-US') + ' km' : '') : '';
                    })() },
                ],
            };
            return rows[view] || [];
        }

        function peakValues(group, values, now) {
            const source = peaks[group];
            function peak(key, value) {
                const old = source[key];
                if (!finite(value)) {
                    if (old && now - old.at > PEAK_HOLD_MS) delete source[key];
                    return source[key] ? source[key].value : null;
                }
                if (!old || now - old.at > PEAK_HOLD_MS || value > old.value) source[key] = { value, at: now };
                return source[key].value;
            }
            return {
                rpm: peak('rpm', values.rpm), power: peak('power', values.power && values.power.value),
                torque: peak('torque', values.torque), powerPct: peak('powerPct', values.powerPct),
                torquePct: peak('torquePct', values.torquePct), boost: peak('boost', values.boost && values.boost.value),
                speed: peak('speed', values.speed),
            };
        }

        function drawDynoCurve(cv, t, run, x, y, w, h, modeColor) {
            if (!run || !Array.isArray(run.curve) || run.curve.length < 2) return;
            const r0 = run.curve[0].rpm, r1 = run.curve[run.curve.length - 1].rpm;
            const pMax = Math.max(1, ...run.curve.map((point) => point.powerW));
            const tMax = Math.max(1, ...run.curve.map((point) => point.torqueNm));
            const powerLine = [], torqueLine = [];
            run.curve.forEach((point) => {
                const px = x + (point.rpm - r0) / Math.max(1, r1 - r0) * w;
                powerLine.push([px, y + h - point.powerW / pMax * h]);
                torqueLine.push([px, y + h - point.torqueNm / tMax * h]);
            });
            cv.fillRect(x, y + h, w, 1, G.withAlpha(t.tick, 0.45));
            cv.polyline(powerLine, 3, modeColor || t.accent);
            cv.polyline(torqueLine, 2, modeColor ? G.mix(modeColor, '#ffffff', 0.3) : t.accent2);
            const peakX = x + (run.peakPrpm - r0) / Math.max(1, r1 - r0) * w;
            cv.circle(peakX, y + h - run.peakP / pMax * h, 4, modeColor || t.accent);
        }

        function drawDynoPanel(cv, t, s, modeColor) {
            const x = 1110, y = G.TOP, w = 466;
            const readingColor = modeColor || '#f32635';
            G.panel(cv, t, x, y, w, 160, 'DYNO RUN');
            const run = s.demo || dynoDisplayCleared ? null : dynoRuns[0];
            const runDate = run && finite(run.at) ? new Date(run.at) : null;
            const dateText = runDate && finite(runDate.getTime())
                ? String(runDate.getDate()).padStart(2, '0') + '.' + String(runDate.getMonth() + 1).padStart(2, '0') + '.' + runDate.getFullYear()
                    + ' ' + String(runDate.getHours()).padStart(2, '0') + ':' + String(runDate.getMinutes()).padStart(2, '0')
                : '--';
            if (run) {
                const titleWidth = cv.textWidth('DYNO RUN', 26, { font: 'bold' });
                cv.text('(LAST RUN - ' + dateText + ')', x + 18 + titleWidth + 10, y + 42, 15, t.dim,
                    { font: 'bold', spacing: 0.5, literal: true });
            }

            if (!run) {
                const split = x + Math.round(w / 2);
                cv.fillRect(split, y + 76, 1, 54, G.withAlpha(t.tick, 0.65));
                cv.text('HORSE POWER', x + 24, y + 88, 15, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text('TORQUE', split + 20, y + 88, 15, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text('0', x + 24, y + 121, 36, readingColor, { font: 'num' });
                const zeroWidth = cv.textWidth('0', 36, { font: 'num' });
                cv.text(Calc.powerUnit(s.powerUnit), x + 27 + zeroWidth, y + 121, 18, t.dim);
                cv.text('0', split + 20, y + 121, 36, readingColor, { font: 'num' });
                const torqueZeroWidth = cv.textWidth('0', 36, { font: 'num' });
                cv.text('Nm', split + 23 + torqueZeroWidth, y + 121, 18, t.dim);
                return;
            }

            const split = x + Math.round(w / 2);
            cv.fillRect(split, y + 76, 1, 66, G.withAlpha(t.tick, 0.65));
            cv.text('HORSE POWER', x + 24, y + 82, 15, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text('TORQUE', split + 20, y + 82, 15, t.dim, { font: 'bold', spacing: 1.5 });
            const powerUnit = s.powerUnit;
            const peakPower = Calc.powerValue(run.peakP / 1000, powerUnit);
            const powerText = formatNumber(peakPower, 0);
            const torqueText = formatNumber(run.peakT, 0);
            const powerWidth = cv.textWidth(powerText, 36, { font: 'num' });
            const torqueWidth = cv.textWidth(torqueText, 36, { font: 'num' });
            cv.text(powerText, x + 24, y + 116, 36, readingColor, { font: 'num' });
            cv.text(Calc.powerUnit(powerUnit), x + 27 + powerWidth, y + 116, 18, t.dim);
            cv.text(torqueText, split + 20, y + 116, 36, readingColor, { font: 'num' });
            cv.text('Nm', split + 23 + torqueWidth, y + 116, 18, t.dim);
            cv.text('@ ' + formatNumber(run.peakPrpm, 0) + ' rpm', x + 24, y + 136, 13, t.dim);
            cv.text('@ ' + formatNumber(run.peakTrpm, 0) + ' rpm', split + 20, y + 136, 13, t.dim);
            drawDynoCurve(cv, t, run, x + 24, y + 143, w - 48, 11, modeColor);
        }

        function drawOilTemps(cv, t, s, modeColor, gaugeColor, y) {
            const w = 216, gap = 34;
            const reading = modeColor || '#f32635';
            const one = (bx, label, value) => {
                const valid = finite(value);
                cv.text(label, bx, y + 20, 16, t.dim, { font: 'bold', spacing: 1.5, literal: true });
                const text = valid ? formatNumber(value, 0) : '--';
                const uw = cv.textWidth(' °C', 19);
                cv.text(text, bx + w - uw, y + 22, 32, valid ? reading : t.dim, { align: 'right', font: 'num' });
                cv.text(' °C', bx + w, y + 22, 19, t.dim, { align: 'right' });
                G.bar(cv, t, bx, y + 34, w, 32, {
                    head: false, value, min: 0, max: 150,
                    color: modeColor ? gaugeColor : undefined, hang: modeColor ? gaugeColor : undefined,
                    ramp: modeColor ? undefined : 'hot',
                });
            };
            one(1110, 'ENGINE OIL', s.oil);
            one(1110 + w + gap, 'GEARBOX OIL', s.gearbox);
        }

        // Mode buttons styled like the oil-bar scales above them: same slab geometry
        // (SL=18, bottom edge x..x+bw), lighter top band, white end slash, scale line.
        const DSC_CHIP = { on: 'DSC ON', traction: 'DSC MDM', off: 'DSC OFF' };
        function drawModeButtons(cv, G, t, mEnabled, mActive, mRun, dscRun) {
            const bh = 50, SL = 18, bw = 198;   // oil bars: w=216 -> bw=w-SL
            const y = G.pageBottom(cv) - bh - 4, cy = y + bh / 2;
            const red = '#f32635';
            const top = 8, oT = Math.round(SL * (bh - top) / bh);  // slim light band so the icon never dips under it

            const chipTop = (bx, liteC, capC) => {
                cv.quad([[bx + SL, y], [bx + bw + SL, y], [bx + bw + oT, y + top], [bx + oT, y + top]], liteC);
                cv.quad([[bx + bw - 10 + SL, y], [bx + bw - 7 + SL, y], [bx + bw - 7, y + bh], [bx + bw - 10, y + bh]], t.bg);
                cv.quad([[bx + bw - 7 + SL, y], [bx + bw + SL, y], [bx + bw, y + bh], [bx + bw - 7, y + bh]], capC);
            };
            const chip = (bx, fillC, liteC, capC) => {
                cv.quad([[bx + SL, y], [bx + bw + SL, y], [bx + bw, y + bh], [bx, y + bh]], fillC);
                chipTop(bx, liteC, capC);
            };
            const mBgv = G.mix(t.bg, red, 0.88);
            const mBg = '#' + mBgv.slice(0, 3).map((v) => ('0' + v.toString(16)).slice(-2)).join('');

            // M SOUND chip — lights up when active
            const mBase = mActive ? mBg : G.mix(t.bg, '#c7cbd1', 0.07);
            chip(1110, mBase, mActive ? G.mix(mBgv, '#ffffff', 0.28) : G.mix(mBase, '#ffffff', 0.15),
                mActive ? '#ffffff' : G.withAlpha('#c7cbd1', 0.34));
            const mTextC = mActive ? '#ffffff' : (mEnabled ? t.text : t.dim);
            const mTw = cv.textWidth('M SOUND MODE', 20, { font: 'bold', spacing: 1.0 });
            const mTextX = 1110 + SL / 2 + Math.round((bw - (mTw + 16)) / 2) - 3;   // centred text+dot group, -3px left
            cv.text('M SOUND MODE', mTextX, cy + 7, 20, mTextC, { font: 'bold', spacing: 1.0, literal: true });
            cv.circle(mTextX + mTw + 11, cy, 5, mActive ? '#3ddb7f' : G.withAlpha('#c7cbd1', 0.5));
            if (cv.own && mRun) cv.target(1110, y, 216, bh, mRun, 'performance_m_sound_mode');

            // DSC chip — text-only, centred on the slab
            cv.quad([[1360 + SL, y], [1360 + bw + SL, y], [1360 + bw, y + bh], [1360, y + bh]], mBg);
            const state = tyreExtra.dsc && tyreExtra.dsc.state;
            const armed = dscWrite.armed;                          // OFF waits for the confirm tap
            const label = armed ? DSC_LABEL[armed] + ' ?' : (DSC_CHIP[state] || 'DSC —');
            const dTw = cv.textWidth(label, 20, { font: 'bold', spacing: 1.0 });
            const capC = armed && Math.floor(Date.now() / 350) % 2 ? '#7a0e1c' : '#ffffff';
            chipTop(1360, G.mix(mBgv, '#ffffff', 0.28), capC);
            cv.text(label, 1360 + SL / 2 + Math.round((bw - dTw) / 2), cy + 7, 20, '#ffffff',
                { font: 'bold', spacing: 1.0, literal: true });
            if (cv.own && dscRun) cv.target(1360, y, 216, bh, dscRun, 'performance_dsc_chip');
        }

        function drawEngine(cv, t, s, modeColor) {
            const room = G.pageBottom(cv) - G.BOTTOM;
            const half = Math.round(room / 2);
            const gaugeColor = modeColor || '#f32635';
            const powerGaugeKw = settings.get('powerGaugeMax');
            const powerMax = Calc.powerValue(finite(powerGaugeKw) && powerGaugeKw > 0 ? powerGaugeKw : 223.7, s.powerUnit);
            const torqueGaugeMax = settings.get('torqueGaugeMax');
            const torqueMax = finite(torqueGaugeMax) && torqueGaugeMax > 0 ? torqueGaugeMax : 800;
            const powerText = !s.power ? '--' : formatNumber(s.power.value, 0);
            const torqueText = s.torque === null ? '--' : formatNumber(s.torque, 0);

            G.segBar(cv, t, 24, G.TOP, 1062, 226 + half, {
                label: 'HORSE POWER', value: s.power ? s.power.value : 0, valueText: powerText, valueColor: s.power ? gaugeColor : t.dim,
                unit: Calc.powerUnit(s.powerUnit), decimals: 0,
                min: 0, max: powerMax, step: powerMax / 20,
                scale: { every: powerMax / 4, div: 1, labelColor: modeColor ? gaugeColor : null, tickColor: modeColor ? gaugeColor : null },
                color: modeColor ? gaugeColor : undefined, hang: modeColor ? gaugeColor : undefined,
                ramp: modeColor ? undefined : 'hot', peak: s.peaks.power,
            });
            G.segBar(cv, t, 24, G.TOP + 242 + half, 1062, 226 - half, {
                label: 'TORQUE', value: s.torque === null ? 0 : s.torque, valueText: torqueText, valueColor: s.torque === null ? t.dim : gaugeColor, unit: 'Nm', decimals: 0,
                min: 0, max: torqueMax, step: torqueMax / 20,
                scale: { every: torqueMax / 4, div: 1, labelColor: modeColor ? gaugeColor : null, tickColor: modeColor ? gaugeColor : null },
                color: modeColor ? gaugeColor : undefined, hang: modeColor ? gaugeColor : undefined,
                ramp: modeColor ? undefined : 'hot', peak: s.peaks.torque,
            });

            drawDynoPanel(cv, t, s, modeColor);

            // G.bar only draws its built-in scale labels for h >= 80; in this compact
            // layout the bars get h = 76 and the scale text is drawn manually below.
            const barLabels = (x, y, w, min, max, ticks, fmt) => {
                const bw = w - 18;
                ticks.forEach((v) => {
                    const align = v <= min ? 'left' : v >= max ? 'right' : 'center';
                    cv.text(fmt(v), x + (v - min) / (max - min) * bw, y + 81 + Math.round(H * 0.01), 14,
                        modeColor ? gaugeColor : G.withAlpha(t.text, 0.85), { align, font: 'bold' });
                });
            };
            // Distribute the screen's spare vertical height (cv.extra) evenly across
            // the three bar rows so they breathe instead of crowding each other.
            const extra = Math.max(0, G.pageBottom(cv) - G.BOTTOM);
            const speedX = 1110, speedY = G.TOP + 168 + Math.round(extra * 0.14), speedW = 466;
            const speedTicks = [0, 50, 100, 150, 200, 250, 300];
            G.bar(cv, t, speedX, speedY, speedW, 76, {
                label: 'VEHICLE SPEED', value: s.speed, text: formatNumber(finite(s.speed) ? s.speed : 0, 0), unit: 'km/h',
                min: 0, max: 300, step: 30, ticks: speedTicks,
                decimals: 0, valueColor: gaugeColor, peak: s.peaks.speed,
                color: modeColor ? gaugeColor : undefined, hang: modeColor ? gaugeColor : undefined, ramp: modeColor ? undefined : 'hot',
            });
            barLabels(speedX, speedY, speedW, 0, 300, speedTicks, (v) => String(v));
            const speedPeak = s.peaks && s.peaks.speed;
            if (finite(speedPeak) && (!finite(s.speed) || speedPeak > s.speed))
                cv.text('PEAK ' + formatNumber(speedPeak, 0) + ' KM/H', speedX + cv.textWidth('VEHICLE SPEED', 22, { font: 'bold', spacing: 2 }) + 18,
                    speedY + 26, 16, modeColor ? gaugeColor : t.accent, { font: 'bold', spacing: 1, literal: true });
            const boostLabel = 'Turbo Boost';
            const boostY = G.TOP + 258 + Math.round(extra * 0.48);
            const boostTicks = Calc.scaleTicks(BOOST_MAX_BAR, 5);
            G.bar(cv, t, 1110, boostY, 466, 76, {
                label: boostLabel, value: s.boost ? s.boost.value : null,
                text: s.boost ? formatNumber(s.boost.value, 2) : '--', unit: 'bar',
                min: 0, max: BOOST_MAX_BAR, step: Calc.scaleStep(BOOST_MAX_BAR, 5), ticks: boostTicks,
                decimals: 2, scaleDecimals: 1, peak: s.peaks.boost, peakText: true,
                valueColor: gaugeColor, color: modeColor ? gaugeColor : undefined,
                hang: modeColor ? gaugeColor : undefined,
                ramp: modeColor ? undefined : 'hot',
            });
            barLabels(1110, boostY, 466, 0, BOOST_MAX_BAR, boostTicks, (v) => formatNumber(v, 1));
            drawOilTemps(cv, t, s, modeColor, gaugeColor, G.TOP + 346 + Math.round(extra * 0.80));
            if (mSoundEnabled && !valveCanActuate()) resetMSound();
            const mSoundReady = valveCanActuate() && !valveController.state.busy && !mSoundBusy;
            drawModeButtons(cv, G, t, mSoundReady, mSoundActive(), toggleMSoundMode, () => {
                queueRender();
                return dscCycle();   // tap cycles DSC ON/OFF from the live state
            });
        }

        async function drawFrame() {
            if (state.stopped) return;
            const demo = settings.get('demo') === 'on';
            const s = current(demo);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            scheduleCarDataArtWarmup(t.bg);
            // Engine Data keeps its tuned dashboard sizing; every other page
            // uses larger, measured text so labels and values stay readable.
            cv.fontSizeScale = page === 0 ? 1 : PAGE_TEXT_SCALE;
            // Keep the shared page header at the same screen y on pages whose content does not
            // reach the bottom. The renderer otherwise vertically centres those pages, moving
            // their x=24, y=44 red-and-grey rule below Engine Data.
            G.pageBottom(cv);
            if (page === 0) {
                const activeMode = modeName(drivingMode) || '';
                const modeColor = /COMFORT/i.test(activeMode) ? '#55a9ff'
                    : /ECO/i.test(activeMode) ? '#3ddb7f'
                    : /ADAPTIVE/i.test(activeMode) ? '#b07cff'
                    : /^SPORT/i.test(activeMode) ? '#f32635' : activeMode ? 'dim' : null;
                const modeBadge = activeMode.toUpperCase().replace(/\+/g, ' PLUS');
                const vehicleDataReady = s.rpm !== null && s.speed !== null;
                drawEngine(cv, t, s, modeColor);
                const notice = valveActionNotice && Date.now() < valveActionNoticeUntil ? valveActionNotice : '';
                G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'RACE MODES', 'CAR DATA', 'WARMUP'], 0, (demo
                    ? [{ text: 'DEMO · NOT VEHICLE DATA', color: 'crit' }]
                    : activeMode ? [{ text: modeBadge, color: modeColor }]
                    : [{ text: driveModeLoading ? 'READING DRIVE MODE' : vehicleDataReady ? 'LIVE DATA' : 'WAITING FOR SIGNALS',
                        color: driveModeLoading || vehicleDataReady ? 'dim' : 'crit' }])
                    .concat(notice ? [{ text: notice, color: 'crit' }] : []));
            } else if (page === 1) {
                const valveView = currentValveView();
                valveView.dsc = {
                    state: tyreExtra.dsc ? tyreExtra.dsc.state : null,
                    busy: dscWrite.busy,
                    status: dscWrite.status, warn: dscWrite.warn,
                };
                FlapUi.draw(cv, G, t, valveView, Object.assign({}, valveActions, burbleActions, dscActions),
                    selectedCarVisual({ bg: FlapUi.CAR_TILE_BG || t.bg }), Date.now(), engineConfigView, sectionActions);
            } else if (page === 2) {
                RaceModesUi.draw(cv, G, t, {
                    dyno() { dynoView = 'sheet'; dynoDisplayCleared = false; return setPage(3); },
                    drag() { dragView = 'live'; return setPage(4); },
                });
            } else if (page === 3) {
                const now = Date.now();
                const recording = dynoRecorder.snapshot(now);
                seedDemoDynoRun();
                DynoUi.draw(cv, G, t, {
                    view: dynoView, runs: dynoRuns, selectedAt: dynoSelectedAt,
                    baselineAt: dynoBaselineAt, cleared: dynoDisplayCleared,
                    pullStatus: recording.status, livePowerW: recording.livePowerW,
                    liveTorqueNm: fresh(state.torque, now) ? state.torque.value : null,
                    rpm: fresh(state.rpm, now) ? state.rpm.value : null,
                    speed: fresh(state.speed, now) ? state.speed.value : null,
                    gateText: dynoGate(now).text,
                    demo, powerUnit: settings.get('powerUnit') || 'hp',
                    torqueUnit: settings.get('dynoTorqueUnit') || 'nm',
                    loss: dynoSetup().loss,
                    ecuTorque: settings.get('dynoEcuTorque') !== false,
                    graphMaxRpm: settings.get('dynoGraphMaxRpm') || 0,
                    flashAt: dynoFlashAt, flashKey: dynoFlashKey,
                }, selectedCarSideVisual({ bg: '#000000' }), {
                    toggleView: toggleDynoView, toggleBaseline: toggleDynoBaseline,
                    clear: clearDynoRuns, nextRun: nextDynoRun, select: selectDynoRun,
                    viewRuns: showDynoRuns,
                    flash: dynoFlash,
                    back: () => setPage(2),
                });
            } else if (page === 4) {
                const now = Date.now(), demoMode = settings.get('demo') === 'on';
                seedDemoDragRuns();
                const selected = dragLiveCleared ? null : dragSelectedRun();
                const isRunning = !!(dragTimer && dragTimer.state === 'run' && !demoMode);
                const run = isRunning ? {
                    result: dragTimer.result, trap: dragTimer.trapSpeed, vmax: dragTimer.vmax,
                    trace: dragTimer.trace, elapsed: dragTimer.elapsed(now), peakG: dragPeakG,
                    wheelspin: dragWheelspin.result(),
                } : selected;
                const unit = dragUnit(), distance = dragDistance();
                DragRunUi.draw(cv, G, t, {
                    view: dragView, runs: dragRuns, selectedAt: dragSelectedAt, selectedRun: selected,
                    section: dragSection, runsPage: dragRunsPage,
                    currentRun: run, listOffset: dragListOffset, best: dragLiveCleared ? {} : dragBest,
                    splits: DragRun.splits(unit, distance.key), speedUnit: unit, distanceLabel: distance.label,
                    rolling: demoMode ? (demoRollingCleared ? {}
                        : { '100-200': 6.42, '200-300': 7.18 }) : rollingResult,
                    rollout: settings.get('dragRollout') === true, timerState: demoMode ? 'ready' : dragTimer.state,
                    elapsed: isRunning ? dragTimer.elapsed(now) : null,
                    speed: !demoMode && fresh(state.speed, now) ? state.speed.value : null,
                    vmax: dragTimer && dragTimer.vmax, trace: dragTimer && dragTimer.trace,
                    peakG: dragPeakG, demo: demoMode, clearArmed: now <= dragClearUntil,
                    slope: demoMode ? -0.52 + 0.06 * Math.sin(now / 3000)
                        : (slopeAt && now - slopeAt <= 2000 ? slopePct : null),
                    flashAt: dynoFlashAt, flashKey: dynoFlashKey,
                }, selectedCarSideVisual({ bg: '#000000' }), {
                    toggleView: toggleDragView, reset: resetDragTimer, clear: clearDragHistory,
                    select: selectDragRun, nextRun: nextDragRun, flash: dynoFlash,
                    openSection: openDragSection, openReport: openDragReport, up: dragBack,
                    clearSection: () => clearDragSection(dragSection),
                    runsPage: (d) => {
                        const max = Math.max(0, Math.ceil(dragSectionRuns().length / DragRunUi.RUNS_PER_PAGE) - 1);
                        dragRunsPage = Math.max(0, Math.min(max, dragRunsPage + (d || 0)));
                        queueRender(); return render();
                    },
                    prevList: () => shiftDragRunList(-1), nextList: () => shiftDragRunList(1),
                    back: () => setPage(2),
                    live: () => { dragView = 'live'; dragClearUntil = 0; queueRender(); return render(); },
                });
            } else if (page === 5) {
                const sectionActions = {};
                CarDataUi.SECTIONS.forEach((sec) => {
                    sectionActions[sec.key] = () => { carDataView = sec.key; tyrePage = 'main'; queueRender(); return render(); };
                });
                const tyresRowsView = carDataView === 'tyres' && tyrePage === 'more' ? 'tyresMore' : carDataView;
                CarDataUi.draw(cv, G, t, {
                    view: carDataView, demo, rows: carDataRows(tyresRowsView, demo, s), tyrePage,
                    // Composite onto the slab's pure black, not theme.bg, so no grey frame shows.
                    side: carDataView === 'menu' ? null : selectedCarSideVisual({ bg: '#000000' }),
                }, Object.assign({
                    back: () => { carDataView = 'menu'; tyrePage = 'main'; queueRender(); return render(); },
                    tyresMore: () => { tyrePage = 'more'; queueRender(); return render(); },
                    tyresMain: () => { tyrePage = 'main'; queueRender(); return render(); },
                }, sectionActions));
            } else if (page === 6) {
                if (demo) {
                    // Demo feed: plausible temperatures climbing so the page animates.
                    warmup.seedDemo();
                    const sec = Date.now() / 1000;
                    warmup.sample({
                        rpm: 900 + 400 * Math.max(0, Math.sin(sec * 0.3)),
                        speed: 0,
                        oil: 82 + 10 * Math.sin(sec * 0.05),
                        coolant: 86 + 6 * Math.sin(sec * 0.05 + 0.6),
                        gearbox: 74 + 6 * Math.sin(sec * 0.05 + 1.2),
                        kw: 0,
                    }, false);
                }
                const wv = warmupView(demo, s);
                wv.demo = demo;
                WarmupUi.draw(cv, G, t, wv);
            }
            if (!demo && Date.now() < fuelReserveUntil) {
                const toastW = 520, toastH = 40, toastX = (W - toastW) / 2, toastY = 50;
                cv.roundRect(toastX, toastY, toastW, toastH, 8, '#6f101b');
                cv.strokeRoundRect(toastX, toastY, toastW, toastH, 8, 2, '#ff3345');
                cv.text('FUEL RESERVE (8L LEFT)', W / 2, toastY + 27, 22, '#ffffff',
                    { align: 'center', font: 'bold', spacing: 1.1, literal: true });
            }
            return ui.image('MAIN_GFX', cv);
        }

        async function render() {
            if (state.stopped) return;
            if (renderInFlight) return renderInFlight;

            const now = Date.now();
            // Exhaust smoke, burble flames and the valve-blade tween are time-driven:
            // while one of those views is up, every loop tick is a fresh frame.
            if (page === 1 && (engineConfigView === 'exhaust' || engineConfigView === 'burbles')) renderDirty = true;
            // The renderer maintains its own frame keepalive. Do not rebuild a
            // screen unless app data, navigation, or layout actually changed.
            const renderInterval = page === 0 ? ENGINE_DATA_RENDER_MS : RENDER_MS;
            if (!renderDirty || now - lastRenderAt < renderInterval) return;

            renderDirty = false;
            const finishRender = () => {
                renderInFlight = null;
                lastRenderAt = Date.now();
                if (renderDirty && !state.stopped) queueRender();
            };
            renderInFlight = Promise.resolve().then(drawFrame).then(() => {
                finishRender();
            }, (e) => {
                log.warn('render: ' + shortError(e));
                finishRender();
            });
            return renderInFlight;
        }

        function queueRender() {
            if (state.stopped) return;
            renderDirty = true;
            if (renderInFlight) return;
            if (mainLoop) { mainLoop.kick(); return; }
            if (renderQueued) return;
            renderQueued = true;
            renderTimer = setTimeout(() => {
                renderQueued = false;
                renderTimer = null;
                render().catch((e) => log.warn('render: ' + shortError(e)));
            }, page === 0 ? ENGINE_DATA_RENDER_MS : RENDER_MS);
        }

        function freshnessSignature(now) {
            if (page === 5 && carDataView === 'menu') return '';
            const parts = [];
            Object.keys(state).forEach((name) => {
                const m = state[name];
                if (!m || typeof m !== 'object' || !finite(m.at) || !m.status) return;
                if (page === 5 && !carDataMetricVisible(name)) return;
                if (page === 3) parts.push(freshWithin(m, now, DYNO_FRESH_MS) ? '1' : '0');
                parts.push(fresh(m, now) ? '1' : '0');
                parts.push(m.status === 'live' && finite(m.value) && now - m.at <= metricStaleMs(name) ? '1' : '0');
            });
            return parts.join('');
        }

        function cleanup() {
            if (state.stopped) return;
            state.stopped = true;
            if (mainLoop) { mainLoop.stop(); mainLoop = null; }
            if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
            if (freshnessTimer) { clearInterval(freshnessTimer); freshnessTimer = null; }
            if (dragPulse) { clearInterval(dragPulse); dragPulse = null; }
            if (dmeTimer) { clearInterval(dmeTimer); dmeTimer = null; }
            if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
            if (carDataArtTimer) { clearTimeout(carDataArtTimer); carDataArtTimer = null; }
            if (smokeTick) { clearInterval(smokeTick); smokeTick = null; }
            if (valveRescanTimer) { clearInterval(valveRescanTimer); valveRescanTimer = null; }
            if (valveNoticeTimer) { clearTimeout(valveNoticeTimer); valveNoticeTimer = null; }
            if (fuelReserveTimer) { clearTimeout(fuelReserveTimer); fuelReserveTimer = null; }
            clearInterval(misfireSaveTimer);
            misfireSave();
            stopDriveModePoll();
            valveAuto._stop();
            if (readOnlyLink) readOnlyLink.cancel();
            dynoRecorder.reset();
            subscriptions.splice(0).forEach(shutdownSubscription);
            diagLog('shutdown', { subscriptionsClosed: true, readOnlyQueueCancelled: true });
        }

        if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('shutdown', cleanup);
        settings.onChange((key) => {
            if (key === 'carModel' || key === 'theme') { carVisualKey = ''; carSideVisualKey = ''; }
            if (key === 'dragSpeedUnit' || key === 'dragDistance' || key === 'dragRollout' || key === 'demo') {
                makeDragTimer();
                dragPeakG = 0;
                dragWheelspin.resetRun();
                dragListOffset = 0;
                dragClearUntil = 0;
            }
            if (key === 'maxPower' || key === 'powerSource' || key === 'powerUnit') {
                delete peaks.live.power;
                delete peaks.demo.power;
            }
            if (key === 'boostSource') delete peaks.live.boost;
            if (key === 'dynoWeight' || key === 'dynoBody' || key === 'dynoLoss' || (key === 'demo' && settings.get('demo') === 'on')) {
                dynoRecorder.reset();
            }
            const valveSetting = { valveControl: 'arm', valveHold: 'hold' }[key];
            if (valveSetting === 'arm') {
                valveReady = false;
                valveScanBusy = true;
                queueRender();
                const disarmFirst = settings.get('valveControl') !== 'on'
                    ? valveAuto.settingsChanged('arm') : Promise.resolve();
                Promise.resolve(disarmFirst).then(() => valveController.refresh()).then(() => {
                    valveReady = true;
                    if (!valveController.armedSetting) return null;
                    if (valveCanActuate() && drivingMode !== null && valveAuto.linkOn) {
                        valveAuto.drive = drivingMode;
                        return valveAuto.linkUp();
                    }
                    return valveAuto.settingsChanged('arm');
                }).then(() => { valveScanBusy = false; queueRender(); })
                    .catch((e) => { valveScanBusy = false; log.warn('exhaust setting: ' + shortError(e)); queueRender(); });
            } else if (valveSetting) {
                Promise.resolve(valveAuto.settingsChanged(valveSetting)).then(queueRender)
                    .catch((e) => log.warn('exhaust setting: ' + shortError(e)));
            }
            queueRender();
        });
        dragPulse = setInterval(() => {
            if (settings.get('demo') === 'on' || !dragTimer) return;
            const previous = dragTimer.state;
            dragTimer.idle(Date.now());
            if (previous !== dragTimer.state || lastDragState !== dragTimer.state) {
                lastDragState = dragTimer.state;
                if (page === 4) queueRender();
            } else if (page === 4 && dragView === 'live' && dragTimer.state === 'run') {
                queueRender();
            }
        }, 100);
        let lastFreshnessSignature = freshnessSignature(Date.now());
        freshnessTimer = setInterval(() => {
            if (settings.get('demo') === 'on') dynoRecorder.reset();
            else {
                const now = Date.now();
                const previousDynoStatus = dynoRecorder.status;
                logDynoGate(now);
                handleDynoEvent(dynoRecorder.tick(now, dynoSetup()));
                if (page === 3 && dynoRecorder.status !== previousDynoStatus) queueRender();
            }
            if (page !== 1 && page !== 2) {
                const signature = freshnessSignature(Date.now());
                if (signature !== lastFreshnessSignature) {
                    lastFreshnessSignature = signature;
                    queueRender();
                }
            }
        }, 1000);
        dmeTimer = setInterval(() => { pollDme().catch((e) => log.warn('DME poll: ' + shortError(e))); }, DME_POLL_MS);

        function setPage(next) {
            page = Math.max(0, Math.min(6, Math.trunc(next)));
            if (page === 1) {
                engineConfigView = 'sections';
            }
            if (page === 5) {
                carDataView = 'menu';
            }
            updateDynoActionLabel();
            queueRender();
            return render();
        }
        function topPageStep(direction) {
            const pages = [0, 1, 2, 5, 6];
            let index = pages.indexOf(page);
            if (index < 0) index = 2;
            return setPage(pages[(index + direction + pages.length) % pages.length]);
        }
        ui.onClick('BTN_PAGE', () => topPageStep(1));
        ui.onClick('BTN_PREV', () => topPageStep(-1));
        ui.onClick('BTN_OPEN', valveActions.open);
        ui.onClick('BTN_CLOSE', valveActions.close);
        ui.onClick('BTN_OEM', valveActions.oem);
        ui.onClick('BTN_DRIVE', valveActions.drive);
        ui.onClick('BTN_DYNO_ACTION', () => {
            if (page === 3) return null;
            dynoView = 'sheet';
            dynoDisplayCleared = false;
            updateDynoActionLabel();
            return setPage(3);
        });
        ui.onClick('BTN_DYNO_VIEW', () => {
            if (page === 3) return null;
            dynoView = 'sheet';
            dynoDisplayCleared = false;
            updateDynoActionLabel();
            return setPage(3);
        });
        ui.onClick('BTN_DRAG_ACTION', () => {
            if (page !== 4) return setPage(4);
            return dragView === 'live' ? resetDragTimer() : clearDragHistory();
        });
        ui.onClick('BTN_DRAG_VIEW', () => {
            if (page !== 4) { dragView = 'history'; return setPage(4); }
            return toggleDragView();
        });
        ['BTN_DYNO_ACTION', 'BTN_DYNO_VIEW', 'BTN_DRAG_ACTION', 'BTN_DRAG_VIEW'].forEach((button) => ctx.hideButton && ctx.hideButton(button));
        ['BTN_OPEN', 'BTN_CLOSE', 'BTN_OEM', 'BTN_DRIVE'].forEach((button) => ctx.hideButton && ctx.hideButton(button));
        updateDynoActionLabel();
        if (ctx.onTab) ctx.onTab((index) => {
            if (index >= 0 && index <= 2) return setPage(index);
            if (index === 3) return setPage(5);
            if (index === 4) return setPage(6);
            return null;
        });
        if (ctx.display) {
            ctx.display.customBackBtn = true;
            ctx.display.onBack = () => {
                // Step back one subpage level; on a top-level tab, return false so the app closes.
                if (page === 1 && engineConfigView !== 'sections') {
                    engineConfigView = 'sections'; dscWrite.armed = null; queueRender(); render(); return true;
                }
                if (page === 3) {
                    if (dynoView !== 'sheet') { dynoView = 'sheet'; queueRender(); render(); return true; }
                    setPage(2); return true;
                }
                if (page === 4) {
                    if (dragView !== 'live') { dragBack(); return true; }
                    setPage(2); return true;
                }
                if (page === 5 && carDataView !== 'menu') {
                    if (tyrePage === 'more') { tyrePage = 'main'; queueRender(); render(); return true; }
                    carDataView = 'menu'; queueRender(); render(); return true;
                }
                return false;
            };
        }

        valveScanBusy = true;
        valveController.start().then(() => {
            valveScanBusy = false;
            if (state.stopped) return;
            valveReady = true;
            if (valveController.link) valveController.link.onAvailable((available) => {
                if (available) bm3ScanRetryCount = 0;
                valveScanBusy = true;
                valveController.refresh().then(() => available ? valveAuto.linkUp() : null)
                    .then(() => { valveScanBusy = false; queueRender(); })
                    .catch((e) => { valveScanBusy = false; log.warn('exhaust link: ' + shortError(e)); queueRender(); });
            });
            if (drivingMode !== null) {
                if (valveCanActuate() && valveAuto.linkOn) {
                    valveAuto.drive = drivingMode;
                    valveAuto.linkUp().then(queueRender).catch((e) => log.warn('exhaust drive mode: ' + shortError(e)));
                } else valveAuto.drive = drivingMode;
            }
            // Like Engine Config, retry read-only DME detection while the engine is
            // running. The retry never sends a valve command.
            valveRescanTimer = setInterval(() => {
                const ident = valveController.ident || {};
                const matched = !!(ident.elAgk && ident.elAgk.supported);
                const bm3 = ident.bm3 || {};
                const platform = valveController.platform;
                const bm3RetryNeeded = (platform === 'auto' || platform === 'bm3') && !bm3.flashed &&
                    /timeout|did not answer|transport unavailable|tasu/i.test(String(bm3.error || ''));
                const now = Date.now();
                const engineRunning = fresh(state.rpm, now) && state.rpm.value > 400;
                if (matched && !bm3RetryNeeded) { valveScanTries = 0; return; }
                if (!valveReady || !valveController.armedSetting || !engineRunning ||
                    !valveController.link || !valveController.link.available || valveScanBusy ||
                    valveController.state.busy || valveController.tune.busy || valveCommandActive || burbleCommandActive) return;
                if (matched && bm3RetryNeeded) {
                    if (bm3ScanRetryCount >= 2 || now - (valveController.link._bm3ScanAt || 0) < 60000) return;
                    bm3ScanRetryCount++;
                }
                if (!matched && valveScanTries >= 4 && now - valveScanAt < 60000) return;
                valveScanBusy = true;
                if (!matched) valveScanTries++;
                valveScanAt = now;
                valveController.refresh().then(() => {
                    if (valveCanActuate() && valveAuto.linkOn && drivingMode !== null) {
                        valveAuto.drive = drivingMode;
                        return valveAuto.linkUp();
                    }
                    return null;
                }).then(queueRender).catch((e) => log.warn('exhaust detection retry: ' + shortError(e)))
                    .then(() => { valveScanBusy = false; });
            }, 15000);
            queueRender();
        }).catch((e) => {
            valveScanBusy = false;
            valveReady = false;
            log.warn('exhaust controller start: ' + shortError(e));
            queueRender();
        });

        ctx.onTap((x, y) => {
            if (x < 1370 || x > 1558 || y < 24 || y > 102) return;
            const button = ui.rhmi && ui.rhmi.getByName && ui.rhmi.getByName('BTN_SETTINGS');
            if (button && typeof button.emit === 'function') button.emit('action', {});
        });
        ctx.onLayout(queueRender);
        diagLog('startup', { version: ctx.spec && ctx.spec.version || 'unknown', engineMonitorReadOnly: true,
            exhaustControlDisarmed: !valveController.armedSetting,
            rawDiagnostics: diagnostics(), dmeCandidates: settings.get('readDmeCandidates') === true });
        // Engine Data gets 20 Hz; other pages retain their 10 Hz renderer cap.
        if (ctx.loop) mainLoop = ctx.loop('MAIN', 10, render, {
            gpuFps: () => page === 0 ? ENGINE_DATA_FPS : 10,
        });
        render().catch((e) => log.warn('first render: ' + shortError(e)));
    },
});
