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
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const FlapUi = require('./flap_ui');
const CarImages = require('./car_images');
const DynoUi = require('./dyno_ui');
const { Controller: FlapController } = require('./flap_controller');
const { AutoFlap, flapFor, modeName } = require('./flap_auto');
const fs = require('fs');
const path = require('path');

const W = 1600, H = 520;
const FRESH_MS = 4500;
const DYNO_FRESH_MS = 500;
const RENDER_MS = 90;
const DME_POLL_MS = 1200;
const PEAK_HOLD_MS = 15000;
const RPM_MAX = 8000;
const BOOST_MAX_BAR = 2.5;
const PRESSURE_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI', BAR: 'BAR', KPA: 'KPA', PSI: 'PSI' };
const DRIVE_STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
const GEAR_NAMES = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10 };

function finite(value) { return typeof value === 'number' && isFinite(value); }
function json(value) {
    try { return JSON.stringify(value); } catch (e) { return '[unserializable]'; }
}
function pressureUnit(value) {
    if (typeof value === 'string') return PRESSURE_UNITS[value.trim().toUpperCase()] || null;
    return PRESSURE_UNITS[value] || null;
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
        const diagnostics = () => settings.get('performanceDiagnostics') === true;
        const config = ctx.spec && ctx.spec.config || {};
        const scaling = config.scaling || {};
        const dme = Object.assign({ ecu: 0x12, boost: [], baro: [] }, config.dme || {});
        const dynoFile = path.join(ctx.dataDir, 'performance_dyno_runs.json');
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
        const dynoRecorder = new Dyno.Recorder();
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
        const peaks = { live: Object.create(null), demo: Object.create(null) };
        const subscriptions = [];
        const diagnosticDedup = Object.create(null);
        let renderTimer = null, renderQueued = false, freshnessTimer = null, dmeTimer = null, demoTimer = null;
        let link = null, reader = null, dmeInit = null;
        let lastDynoGate = null;
        let vehicleGear = null, vehicleGearAt = 0;
        let page = 0, engineConfigView = 'sections', valveReady = false, drivingMode = null;
        let driveModeLoading = false, driveModePollStarting = false, driveModePollSub = null, driveModePollTimer = null;
        let valveTick = null, valveRescanTimer = null, smokeTick = null;
        let valveScanBusy = false, valveScanTries = 0, valveScanAt = 0;
        let carVisual = null, carVisualKey = '', carSideVisual = null, carSideVisualKey = '';
        let mSoundEnabled = false;
        let mSoundBusy = false;
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
            try { fs.writeFileSync(dynoFile, JSON.stringify({ runs: dynoRuns, baselineAt: dynoBaselineAt })); }
            catch (e) { log.warn('virtual dyno save: ' + shortError(e)); }
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
            updateDynoActionLabel();
            queueRender();
            return render();
        }

        function clearDynoDisplay() {
            dynoDisplayCleared = true;
            dynoSelectedAt = null;
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

        function updateDynoActionLabel() {
            const run = displayedDynoRun();
            const label = page !== 2 ? 'Open DYNO MODE' : dynoView === 'runs' ? 'Next saved run'
                : run && dynoBaselineAt === run.at ? 'Clear baseline' : 'Set baseline';
            if (ui.text) ui.text('BTN_DYNO_ACTION', label);
            if (ui.text) ui.text('BTN_DYNO_VIEW', page !== 2 ? 'Saved runs' : dynoView === 'runs' ? 'DYNO sheet' : 'Saved runs');
        }

        // Reuse Engine Config's per-DME controller and Drive Mode logic. The
        // installed app starts disarmed; only the explicit setting can arm it.
        const valveKeys = { arm: 'valveControl', hold: 'valveHold', closeLimit: 'valveCloseLimit' };
        const valveSettings = {
            get(key) { return settings.get(valveKeys[key] || key); },
            set(key, value) { return settings.set(valveKeys[key] || key, value); },
        };
        const valveController = new FlapController(Object.assign({}, ctx, { settings: valveSettings }));
        const valveAuto = new AutoFlap({
            controller: valveController,
            get: (key) => valveSettings.get(key), set: (key, value) => valveSettings.set(key, value),
            rpm: () => fresh(state.rpm, Date.now()) ? state.rpm.value : null,
            log, onChange: () => queueRender(),
        });
        function valveCanActuate() {
            const control = valveController.view();
            return valveReady && valveController.armedSetting && !control.blocked &&
                !!(valveController.ident && valveController.ident.elAgk && valveController.ident.elAgk.supported);
        }

        function resetMSound() {
            mSoundEnabled = false;
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
                queueRender();
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
            queueRender();
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
            const details = { signal: name, source: source || 'unknown', raw, value, unit: unit || '', status: status || 'live' };
            if (diagnostics()) {
                const now = Date.now(), signature = json(details), old = diagnosticDedup[name];
                if (!old || old.signature !== signature || now - old.at >= 30000) {
                    diagnosticDedup[name] = { signature, at: now };
                    diagLog('payload', details);
                }
            }
        }

        function updateMetric(name, raw, value, unit, source, status) {
            state[name] = {
                raw, value: finite(value) ? value : null, unit: unit || '', source: source || '',
                at: Date.now(), status: status || (finite(value) ? 'live' : 'invalid'),
            };
            record(name, raw, finite(value) ? value : null, unit, source, state[name].status);
            queueRender();
        }

        function onProvider(iface, available) {
            state.providers[iface] = !!available;
            diagLog('provider', { interface: iface, available: !!available });
            queueRender();
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
            updateMetric('speed', raw, finite(value) && value >= 0 && value <= 400 ? value : null,
                'km/h', source, finite(value) && value >= 0 && value <= 400 ? 'live' : 'invalid');
            feedDyno();
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
            queueRender();
        }

        function setGearSelection(payload) {
            const label = selectedGearLabel(payload && payload.statusGearSelectionDrive);
            if (!label) return;
            vehicleGear = label;
            vehicleGearAt = Date.now();
            queueRender();
        }

        function setLongitudinalAcceleration(payload, source) {
            const raw = payload && payload.longitudinalAccelerationCentreOfGravity;
            const mps2 = Calc.scale(raw, scaling.accel);
            const value = finite(mps2) ? mps2 / 9.80665 : null;
            const valid = finite(value) && Math.abs(value) <= 8;
            updateMetric('gLong', raw, valid ? value : null, 'g', source, valid ? 'live' : 'invalid');
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
        }

        function setPressureUnits(payload, source) {
            const raw = payload && payload.unitOfMeasurementAirPressure;
            const unit = pressureUnit(raw);
            state.pressureUnit = unit;
            diagLog('pressure_units', { source, raw, unit: unit || 'unknown' });
            if (state.boostFes.at) setFesBoost({ displayBoostPressure: state.boostFes.raw }, 'reconvert');
            queueRender();
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
            const selectedMode = valveAuto.selected();
            const effectiveMode = valveAuto.effective();
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
            return Object.assign({}, control, {
                ready: valveReady, armed, matched, status, lines, visualState, commandStatus,
                // The exhaust art follows the requested mode as a visual cue only;
                // the DME's reported position is separately labelled unverified.
                exhaustMode: valveAuto.effective(),
                modeLabel,
                drivingMode: modeName(drivingMode),
                driveModeLoading,
                page, selected: valveAuto.selected(),
                requested: valveAuto.desired,
                note: note && note.text,
            });
        }

        function stopDriveModePoll() {
            if (driveModePollTimer) { clearTimeout(driveModePollTimer); driveModePollTimer = null; }
            const sub = driveModePollSub;
            driveModePollSub = null;
            if (sub) shutdownSubscription(sub);
        }

        function startDriveModePoll() {
            if (state.stopped || drivingMode !== null || driveModePollStarting || driveModePollSub) return;
            driveModeLoading = true;
            driveModePollStarting = true;
            queueRender();
            // The regular FES subscription handles changes. This one-field
            // read-only poll supplements it during startup if the first value
            // is BMW's INITIALISIERUNG/invalid state, then closes on a valid mode.
            startWatch(FES, { statusFESVehicleDynamicSwitchHMI: applyDrivingMode }, {
                pollMs: 1500,
                onDiagnostic: () => {},
            }).then((sub) => {
                driveModePollStarting = false;
                if (!sub) {
                    driveModeLoading = false;
                    queueRender();
                    return;
                }
                if (drivingMode !== null || state.stopped) {
                    shutdownSubscription(sub);
                    return;
                }
                driveModePollSub = sub;
                if (sub.error) {
                    stopDriveModePoll();
                    driveModeLoading = false;
                    queueRender();
                    return;
                }
                // Bound the startup polling window; the main event subscription
                // remains active and will still accept a later valid update.
                driveModePollTimer = setTimeout(() => {
                    stopDriveModePoll();
                    driveModeLoading = false;
                    queueRender();
                }, 20000);
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
            drivingMode = raw;
            driveModeLoading = false;
            stopDriveModePoll();
            if (!valveCanActuate()) { valveAuto.drive = raw; return; }
            const pending = valveAuto.driveMode(raw);
            if (pending) pending.then(queueRender).catch((e) => log.warn('exhaust drive mode: ' + shortError(e)));
            else queueRender();
        }

        const valvePress = (mode) => () => {
            if (mode === 'DRIVE' && drivingMode === null) startDriveModePoll();
            if (!valveCanActuate()) {
                diagLog('valve_command_blocked', { mode, ready: valveReady,
                    armed: valveController.armedSetting,
                    matched: !!(valveController.ident && valveController.ident.elAgk && valveController.ident.elAgk.supported) });
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
        function toggleMSoundMode() {
            if (!valveCanActuate() || valveController.state.busy || mSoundBusy) return null;
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
            open() {
                engineConfigView = 'exhaust';
                if (!smokeTick) smokeTick = setInterval(queueRender, 180);
                queueRender();
            },
        };
        ui.onClick('BTN_SECTION', sectionActions.open);
        if (ctx.hideButton) ctx.hideButton('BTN_SECTION');

        const CDS = 'de.bmw.infotainment.vehicle.CDS';
        const CDS2 = 'de.bmw.infotainment.vehicle.CDS2';
        const VEHICLE = 'de.bmw.infotainment.vehicle.Vehicle';
        const VEHICLE2 = 'de.bmw.infotainment.vehicle.Vehicle2';
        const VEHICLE_INFO = 'de.bmw.infrastructure.VehicleInformation';
        const FES = 'de.bmw.infotainment.drivingexcitement.FES';
        startWatch(CDS, { statusEngineSpeed2: setRpm });
        startWatch(CDS2, { statusLongitudinalAccelerationMassCenter: setLongitudinalAcceleration });
        startWatch(VEHICLE, { statusNewCurrentUnitsStatusExt: setPressureUnits });
        startWatch(VEHICLE2, { statusCarSpeed2: setVehicleSpeed });
        startWatch(VEHICLE_INFO, { statusGearboxDrive: setGearboxStatus, DataPowerTrain2: setGearSelection });
        startWatch(FES, {
            statusActualValueTorque2: setFesTorque,
            statusVehicleDynamicEngine: setFesPercentages,
            statusSwitchDriveDynamicSport2: setFesBoost,
            statusFESVehicleDynamicSwitchHMI: applyDrivingMode,
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

        let lastDmeCycle = 0;
        async function pollDme() {
            const now = Date.now();
            if (state.stopped || state.dmeBusy || settings.get('demo') === 'on' ||
                settings.get('readDmeCandidates') !== true || valveCommandActive ||
                valveController.state.busy || now < valvePriorityUntil) return;
            if (!fresh(state.rpm, now) || state.rpm.value < 500 || now - lastDmeCycle < DME_POLL_MS) return;
            const boostSource = settings.get('boostSource') || 'auto';
            const needsDmeBoost = boostSource === 'dme' ||
                (boostSource === 'auto' && !(fresh(state.boostFes, now) && fesBoostTrusted));
            if (!needsDmeBoost || boostSource === 'fes') return;
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
                    return;
                }
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
            } catch (e) {
                diagLog('dme_poll_error', { error: shortError(e) });
                log.warn('DME poll: ' + shortError(e));
            } finally {
                state.dmeBusy = false;
            }
        }

        function selectTorque(now) {
            if (fresh(state.torqueFes, now)) return { value: state.torqueFes.value, source: 'BMW SPORT SIGNAL' };
            return null;
        }

        function boostValue(now) {
            const source = settings.get('boostSource') || 'auto';
            if (source !== 'dme' && fresh(state.boostFes, now) && (source === 'fes' || fesBoostTrusted)) {
                return { value: state.boostFes.value, approximate: true, source: 'BMW SPORT DISPLAY' };
            }
            if (source !== 'fes' && fresh(state.boostDme, now) && (source === 'dme' || dmeBoostTrusted)) {
                return { value: state.boostDme.value, approximate: !state.baroMeasured, source: state.boostDme.source };
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
                };
                result.peaks = peakValues('demo', result, now);
                return result;
            }
            const rpm = fresh(state.rpm, now) ? state.rpm.value : null;
            const tq = selectTorque(now);
            const powerPct = fresh(state.powerPct, now) ? state.powerPct.value : null;
            const torque = tq ? tq.value : null;
            const result = {
                demo: false, rpm, torque, torqueSource: tq ? tq.source : null,
                power: powerFor(powerPct, torque, rpm), powerUnit,
                powerPct,
                speed: fresh(state.speed, now) ? state.speed.value : null,
                gear: vehicleGearAt && now - vehicleGearAt <= FRESH_MS ? vehicleGear : null,
                torquePct: fresh(state.torquePct, now) ? state.torquePct.value : null,
                boost: boostValue(now),
            };
            result.peaks = peakValues('live', result, now);
            return result;
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
            };
        }

        function drawDynoCurve(cv, t, run, x, y, w, h) {
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
            cv.polyline(powerLine, 3, t.accent);
            cv.polyline(torqueLine, 2, t.accent2);
            const peakX = x + (run.peakPrpm - r0) / Math.max(1, r1 - r0) * w;
            cv.circle(peakX, y + h - run.peakP / pMax * h, 4, t.accent);
        }

        function drawDynoPanel(cv, t, s) {
            const x = 1110, y = G.TOP, w = 466;
            G.panel(cv, t, x, y, w, 160, 'DYNO RUN');
            const run = s.demo ? null : dynoRuns[0];
            const runDate = run && finite(run.at) ? new Date(run.at) : null;
            const dateText = runDate && finite(runDate.getTime())
                ? String(runDate.getDate()).padStart(2, '0') + '.' + String(runDate.getMonth() + 1).padStart(2, '0') + '.' + runDate.getFullYear()
                : '--';
            const titleWidth = cv.textWidth('DYNO RUN', 26, { font: 'bold' });
            cv.text('(LAST RUN - ' + dateText + ')', x + 18 + titleWidth + 10, y + 42, 15, t.dim,
                { font: 'bold', spacing: 0.5, literal: true });

            if (!run) {
                const split = x + Math.round(w / 2);
                cv.fillRect(split, y + 76, 1, 54, G.withAlpha(t.tick, 0.65));
                cv.text('HORSE POWER', x + 24, y + 88, 15, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text('TORQUE', split + 20, y + 88, 15, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text('0', x + 24, y + 121, 36, '#f32635', { font: 'num' });
                const zeroWidth = cv.textWidth('0', 36, { font: 'num' });
                cv.text(Calc.powerUnit(s.powerUnit), x + 27 + zeroWidth, y + 121, 18, t.dim);
                cv.text('0', split + 20, y + 121, 36, '#f32635', { font: 'num' });
                cv.text('Nm', split + 23 + zeroWidth, y + 121, 18, t.dim);
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
            cv.text(powerText, x + 24, y + 116, 36, '#f32635', { font: 'num' });
            cv.text(Calc.powerUnit(powerUnit), x + 27 + powerWidth, y + 116, 18, t.dim);
            cv.text(torqueText, split + 20, y + 116, 36, '#f32635', { font: 'num' });
            cv.text('Nm', split + 23 + torqueWidth, y + 116, 18, t.dim);
            cv.text('@ ' + formatNumber(run.peakPrpm, 0) + ' rpm', x + 24, y + 136, 13, t.dim);
            cv.text('@ ' + formatNumber(run.peakTrpm, 0) + ' rpm', split + 20, y + 136, 13, t.dim);
            drawDynoCurve(cv, t, run, x + 24, y + 143, w - 48, 11);
        }

        function drawMSoundButton(cv, t, enabled, active, run) {
            const x = 1110, y = G.TOP + 392, w = 466, h = 70;
            const red = '#f32635';
            const edge = active ? red : G.withAlpha('#c7cbd1', enabled ? 0.42 : 0.2);
            cv.roundRect(x, y, w, h, 8, active ? G.withAlpha(red, 0.88) : G.withAlpha('#c7cbd1', 0.07));
            cv.strokeRoundRect(x, y, w, h, 8, 2, edge);
            cv.fillRect(x + 1, y + 12, 4, h - 24, active ? red : G.withAlpha('#c7cbd1', enabled ? 0.48 : 0.24));
            cv.text('M SOUND MODE', x + 24, y + 44, 23, active ? '#ffffff' : (enabled ? t.text : t.dim),
                { font: 'bold', spacing: 1.2, literal: true });
            cv.circle(x + w - 28, y + h / 2, 7, active ? '#ffffff' : G.withAlpha('#c7cbd1', 0.34));
            if (cv.own && enabled && run) cv.target(x, y, w, h, run, 'performance_m_sound_mode');
        }

        function drawEngine(cv, t, s) {
            const room = G.pageBottom(cv) - G.BOTTOM;
            const half = Math.round(room / 2);
            const powerGaugeKw = settings.get('powerGaugeMax');
            const powerMax = Calc.powerValue(finite(powerGaugeKw) && powerGaugeKw > 0 ? powerGaugeKw : 223.7, s.powerUnit);
            const torqueGaugeMax = settings.get('torqueGaugeMax');
            const torqueMax = finite(torqueGaugeMax) && torqueGaugeMax > 0 ? torqueGaugeMax : 800;
            const powerText = !s.power ? '0' : (s.power.approximate ? '~' : '') + formatNumber(s.power.value, 0);
            const torqueText = s.torque === null ? '0' : formatNumber(s.torque, 0);

            G.segBar(cv, t, 24, G.TOP, 1062, 226 + half, {
                label: 'HORSE POWER', value: s.power ? s.power.value : 0, valueText: powerText, valueColor: '#f32635',
                unit: Calc.powerUnit(s.powerUnit), decimals: 0,
                min: 0, max: powerMax, step: powerMax / 20,
                scale: { every: powerMax / 4, div: 1 },
                ramp: 'hot', peak: s.peaks.power,
            });
            G.segBar(cv, t, 24, G.TOP + 242 + half, 1062, 226 - half, {
                label: 'TORQUE', value: s.torque === null ? 0 : s.torque, valueText: torqueText, valueColor: '#f32635', unit: 'Nm', decimals: 0,
                min: 0, max: torqueMax, step: torqueMax / 20,
                scale: { every: torqueMax / 4, div: 1 },
                ramp: 'hot', peak: s.peaks.torque,
            });

            drawDynoPanel(cv, t, s);

            const speedX = 1110, speedY = G.TOP + 172, speedW = 466;
            const speedTicks = [0, 60, 120, 210, 270, 330];
            G.bar(cv, t, speedX, speedY, speedW, 96, {
                label: 'VEHICLE SPEED', value: s.speed, text: s.speed === null ? '--' : formatNumber(s.speed, 0), unit: 'km/h',
                min: 0, max: 330, step: 30, ticks: speedTicks,
                labels: [0, 120, 210, 330].map((value) => ({ value, text: String(value), align: value === 0 ? 'left' : value === 330 ? 'right' : 'center' })),
                decimals: 0, ramp: 'hot',
            });
            const speedScaleX = speedX + 18;
            [60, 270].forEach((value) => cv.text(String(value), speedScaleX + value / 330 * (speedW - 18),
                speedY + 92, 14, t.dim, { align: 'center', font: 'bold' }));
            const gear = s.gear || '--';
            const gearX = speedX + cv.textWidth('VEHICLE SPEED', 22, { font: 'bold', spacing: 2 }) + 18;
            cv.text('GEAR ' + gear, gearX, speedY + 26, 16, t.accent, { font: 'bold', spacing: 1, literal: true });
            const boostLabel = 'Turbo Boost';
            const boostTicks = Calc.scaleTicks(BOOST_MAX_BAR, 5);
            G.bar(cv, t, 1110, G.TOP + 280, 466, 96, {
                label: boostLabel, value: s.boost ? s.boost.value : null,
                text: s.boost ? formatNumber(s.boost.value, 2) : '--', unit: 'bar',
                min: 0, max: BOOST_MAX_BAR, step: Calc.scaleStep(BOOST_MAX_BAR, 5), ticks: boostTicks,
                decimals: 2, scaleDecimals: 1, peak: s.peaks.boost, peakText: true, ramp: 'hot',
            });
            if (mSoundEnabled && !valveCanActuate()) resetMSound();
            const mSoundReady = valveCanActuate() && !valveController.state.busy && !mSoundBusy;
            drawMSoundButton(cv, t, mSoundReady, mSoundEnabled, toggleMSoundMode);
        }

        async function render() {
            if (state.stopped) return;
            const demo = settings.get('demo') === 'on';
            const s = current(demo);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) {
                drawEngine(cv, t, s);
                G.frame(cv, t, ['Engine Data', 'ENGINE CONFIG', 'DYNO MODE'], page, demo
                    ? [{ text: 'DEMO · NOT VEHICLE DATA', color: 'crit' }]
                    : [{ text: 'READ ONLY', color: 'dim' }]);
            } else if (page === 1) {
                FlapUi.draw(cv, G, t, currentValveView(), valveActions,
                    selectedCarVisual(t), Date.now(), engineConfigView, sectionActions);
            } else {
                const now = Date.now();
                const recording = dynoRecorder.snapshot(now);
                DynoUi.draw(cv, G, t, {
                    view: dynoView, runs: dynoRuns, selectedAt: dynoSelectedAt,
                    baselineAt: dynoBaselineAt, cleared: dynoDisplayCleared,
                    pullStatus: recording.status, livePowerW: recording.livePowerW,
                    rpm: fresh(state.rpm, now) ? state.rpm.value : null,
                    speed: fresh(state.speed, now) ? state.speed.value : null,
                    gateText: dynoGate(now).text,
                    demo, powerUnit: settings.get('powerUnit') || 'hp',
                    torqueUnit: settings.get('dynoTorqueUnit') || 'nm',
                    ecuTorque: settings.get('dynoEcuTorque') !== false,
                    graphMaxRpm: settings.get('dynoGraphMaxRpm') || 0,
                }, selectedCarSideVisual(t), {
                    toggleView: toggleDynoView, toggleBaseline: toggleDynoBaseline,
                    clear: clearDynoDisplay, nextRun: nextDynoRun, select: selectDynoRun,
                });
            }
            return ui.image('MAIN_GFX', cv);
        }

        function queueRender() {
            if (state.stopped || renderQueued) return;
            renderQueued = true;
            renderTimer = setTimeout(() => {
                renderQueued = false;
                renderTimer = null;
                render().catch((e) => log.warn('render: ' + shortError(e)));
            }, RENDER_MS);
        }

        function cleanup() {
            if (state.stopped) return;
            state.stopped = true;
            if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
            if (freshnessTimer) { clearInterval(freshnessTimer); freshnessTimer = null; }
            if (dmeTimer) { clearInterval(dmeTimer); dmeTimer = null; }
            if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
            if (smokeTick) { clearInterval(smokeTick); smokeTick = null; }
            if (valveTick) { clearInterval(valveTick); valveTick = null; }
            if (valveRescanTimer) { clearInterval(valveRescanTimer); valveRescanTimer = null; }
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
            if (key === 'maxPower' || key === 'powerSource' || key === 'powerUnit') {
                delete peaks.live.power;
                delete peaks.demo.power;
            }
            if (key === 'boostSource') delete peaks.live.boost;
            if (key === 'dynoWeight' || key === 'dynoBody' || key === 'dynoLoss' || (key === 'demo' && settings.get('demo') === 'on')) {
                dynoRecorder.reset();
            }
            if (key === 'demo' && settings.get('demo') === 'on' && !demoTimer) demoTimer = setInterval(queueRender, 250);
            if (key === 'demo' && settings.get('demo') !== 'on' && demoTimer) { clearInterval(demoTimer); demoTimer = null; }
            const valveSetting = { valveControl: 'arm', valveHold: 'hold', valveCloseLimit: 'closeLimit' }[key];
            if (valveSetting === 'arm') {
                valveReady = false;
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
                }).then(queueRender).catch((e) => log.warn('exhaust setting: ' + shortError(e)));
            } else if (valveSetting) {
                Promise.resolve(valveAuto.settingsChanged(valveSetting)).then(queueRender)
                    .catch((e) => log.warn('exhaust setting: ' + shortError(e)));
            }
            queueRender();
        });
        if (settings.get('demo') === 'on') demoTimer = setInterval(queueRender, 250);
        freshnessTimer = setInterval(() => {
            if (settings.get('demo') === 'on') dynoRecorder.reset();
            else {
                const now = Date.now();
                logDynoGate(now);
                handleDynoEvent(dynoRecorder.tick(now, dynoSetup()));
            }
            queueRender();
        }, 1000);
        dmeTimer = setInterval(() => { pollDme().catch((e) => log.warn('DME poll: ' + shortError(e))); }, 350);

        function setPage(next) {
            page = ((next % 3) + 3) % 3;
            if (page === 1) {
                engineConfigView = 'sections';
            }
            updateDynoActionLabel();
            if (page !== 1 && smokeTick) { clearInterval(smokeTick); smokeTick = null; }
            queueRender();
            return render();
        }
        ui.onClick('BTN_PAGE', () => setPage(page + 1));
        ui.onClick('BTN_PREV', () => setPage(page - 1));
        ui.onClick('BTN_OPEN', valveActions.open);
        ui.onClick('BTN_CLOSE', valveActions.close);
        ui.onClick('BTN_OEM', valveActions.oem);
        ui.onClick('BTN_DRIVE', valveActions.drive);
        ui.onClick('BTN_DYNO_ACTION', () => {
            if (page !== 2) {
                dynoView = 'sheet';
                dynoDisplayCleared = false;
                updateDynoActionLabel();
                return setPage(2);
            }
            return dynoView === 'runs' ? nextDynoRun() : toggleDynoBaseline();
        });
        ui.onClick('BTN_DYNO_VIEW', () => {
            if (page === 2) return toggleDynoView();
            dynoView = 'runs';
            dynoDisplayCleared = false;
            updateDynoActionLabel();
            return setPage(2);
        });
        ['BTN_DYNO_ACTION', 'BTN_DYNO_VIEW'].forEach((button) => ctx.hideButton && ctx.hideButton(button));
        ['BTN_OPEN', 'BTN_CLOSE', 'BTN_OEM', 'BTN_DRIVE'].forEach((button) => ctx.hideButton && ctx.hideButton(button));
        updateDynoActionLabel();
        if (ctx.onTab) ctx.onTab((index) => {
            if (index === 0 || index === 1 || index === 2) return setPage(index);
            return null;
        });

        valveController.start().then(() => {
            if (state.stopped) return;
            valveReady = true;
            if (valveController.link) valveController.link.onAvailable((available) => {
                valveController.refresh().then(() => available ? valveAuto.linkUp() : null)
                    .then(queueRender).catch((e) => log.warn('exhaust link: ' + shortError(e)));
            });
            if (drivingMode !== null) {
                if (valveCanActuate() && valveAuto.linkOn) {
                    valveAuto.drive = drivingMode;
                    valveAuto.linkUp().then(queueRender).catch((e) => log.warn('exhaust drive mode: ' + shortError(e)));
                } else valveAuto.drive = drivingMode;
            }
            valveTick = setInterval(() => {
                if (!valveCanActuate()) return;
                valveAuto.tick().catch((e) => log.warn('exhaust rpm guard: ' + shortError(e)));
            }, 250);
            // Like Engine Config, retry read-only DME detection while the engine is
            // running. The retry never sends a valve command.
            valveRescanTimer = setInterval(() => {
                const ident = valveController.ident || {};
                const matched = !!(ident.elAgk && ident.elAgk.supported);
                if (matched) { valveScanTries = 0; return; }
                const now = Date.now();
                const engineRunning = fresh(state.rpm, now) && state.rpm.value > 400;
                if (!valveReady || !valveController.armedSetting || !engineRunning ||
                    !valveController.link || !valveController.link.available || valveScanBusy) return;
                if (valveScanTries >= 4 && now - valveScanAt < 60000) return;
                valveScanBusy = true; valveScanTries++; valveScanAt = now;
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
        render().catch((e) => log.warn('first render: ' + shortError(e)));
    },
});
