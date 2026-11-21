'use strict';

/**
 * Performance - read-only engine monitor for MGU / iDrive 7.
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

function finite(value) { return typeof value === 'number' && isFinite(value); }
function json(value) {
    try { return JSON.stringify(value); } catch (e) { return '[unserializable]'; }
}
function pressureUnit(value) {
    if (typeof value === 'string') return PRESSURE_UNITS[value.trim().toUpperCase()] || null;
    return PRESSURE_UNITS[value] || null;
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
        let dynoRuns = [];
        try {
            const saved = JSON.parse(fs.readFileSync(dynoFile, 'utf8'));
            if (saved && Array.isArray(saved.runs)) dynoRuns = saved.runs.filter((run) =>
                run && finite(run.peakP) && finite(run.peakT) && finite(run.peakPrpm) && finite(run.peakTrpm) &&
                Array.isArray(run.curve) && run.curve.length > 1 && run.curve.every((point) =>
                    point && finite(point.rpm) && finite(point.powerW) && finite(point.torqueNm))).slice(0, 20);
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
            try { fs.writeFileSync(dynoFile, JSON.stringify({ runs: dynoRuns })); }
            catch (e) { log.warn('virtual dyno save: ' + shortError(e)); }
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
                ? { rpm: state.rpm.value, speedKmh: state.speed.value, longitudinalG: state.gLong.value }
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

        function startWatch(iface, handlers) {
            let pending;
            try {
                pending = ctx.signals.watch(iface, '1', handlers, log, {
                    onAvailability: (available) => onProvider(iface, available),
                    onDiagnostic: onRuntimeDiagnostic,
                });
            } catch (e) {
                diagLog('watch_call_error', { interface: iface, error: shortError(e) });
                log.warn('Performance signal ' + iface + ': ' + shortError(e));
                return;
            }
            Promise.resolve(pending).then((sub) => {
                if (!sub) {
                    diagLog('watch_completed', { interface: iface, result: 'no result' });
                    return;
                }
                subscriptions.push(sub);
                diagLog('watch_completed', { interface: iface, error: sub.error || null, available: sub.available === true });
                if (sub.error) {
                    log.warn('Performance signal ' + iface + ': ' + sub.error);
                    onProvider(iface, false);
                } else if (typeof sub.available === 'boolean') onProvider(iface, sub.available);
                if (state.stopped) shutdownSubscription(sub);
            }).catch((e) => {
                diagLog('watch_rejected', { interface: iface, error: shortError(e) });
                log.warn('Performance signal ' + iface + ': ' + shortError(e));
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

        const CDS = 'de.bmw.infotainment.vehicle.CDS';
        const CDS2 = 'de.bmw.infotainment.vehicle.CDS2';
        const VEHICLE = 'de.bmw.infotainment.vehicle.Vehicle';
        const VEHICLE2 = 'de.bmw.infotainment.vehicle.Vehicle2';
        const FES = 'de.bmw.infotainment.drivingexcitement.FES';
        startWatch(CDS, { statusEngineSpeed2: setRpm });
        startWatch(CDS2, { statusLongitudinalAccelerationMassCenter: setLongitudinalAcceleration });
        startWatch(VEHICLE, { statusNewCurrentUnitsStatusExt: setPressureUnits });
        startWatch(VEHICLE2, { statusCarSpeed2: setVehicleSpeed });
        startWatch(FES, {
            statusActualValueTorque2: setFesTorque,
            statusVehicleDynamicEngine: setFesPercentages,
            statusSwitchDriveDynamicSport2: setFesBoost,
        });

        // Read-only DME candidates: only ISO-TP/UDS 0x22 ReadDataByIdentifier.
        // There are no setter, reset, session, or actuation calls in this app.
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
                settings.get('readDmeCandidates') !== true) return;
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
            G.panel(cv, t, x, y, w, 190, 'VIRTUAL DYNO');
            const snap = dynoRecorder.snapshot(Date.now());
            const run = s.demo ? null : dynoRuns[0];
            const status = s.demo ? 'PAUSED IN DEMO' : snap.status === 'recording' ? 'RECORDING FULL-THROTTLE PULL'
                : snap.status === 'done' ? 'NEW PULL RECORDED' : snap.status === 'short' ? 'PULL TOO SHORT'
                    : run ? 'LATEST ROAD PULL · ESTIMATE' : 'NO PULL RECORDED';
            const statusColor = snap.status === 'done' ? t.ok : snap.status === 'recording' ? t.crit : t.dim;
            cv.text(status, x + 24, y + 68, 18, statusColor, { font: 'bold', spacing: 1 });

            if (!run) {
                const split = x + Math.round(w / 2);
                cv.fillRect(split, y + 84, 1, 61, G.withAlpha(t.tick, 0.65));
                cv.text('HORSE POWER', x + 24, y + 94, 17, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text('TORQUE', split + 20, y + 94, 17, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text('--', x + 24, y + 137, 42, t.dim, { font: 'num' });
                cv.text(Calc.powerUnit(s.powerUnit), x + 82, y + 137, 20, t.dim);
                cv.text('--', split + 20, y + 137, 42, t.dim, { font: 'num' });
                cv.text('Nm', split + 78, y + 137, 20, t.dim);
                const gate = dynoGate(Date.now());
                const note = s.demo ? 'No simulated dyno figures are shown'
                    : snap.status === 'short' ? 'One gear · sweep at least 1500 rpm'
                        : gate.text;
                cv.text(note, x + 24, y + 161, 17, t.dim);
                return;
            }

            const split = x + Math.round(w / 2);
            cv.fillRect(split, y + 84, 1, 73, G.withAlpha(t.tick, 0.65));
            cv.text('HORSE POWER', x + 24, y + 94, 17, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text('TORQUE', split + 20, y + 94, 17, t.dim, { font: 'bold', spacing: 1.5 });
            const powerUnit = s.powerUnit;
            const peakPower = Calc.powerValue(run.peakP / 1000, powerUnit);
            const powerText = formatNumber(peakPower, 0);
            const torqueText = formatNumber(run.peakT, 0);
            const powerWidth = cv.textWidth(powerText, 42, { font: 'num' });
            const torqueWidth = cv.textWidth(torqueText, 42, { font: 'num' });
            cv.text(powerText, x + 24, y + 137, 42, t.accent, { font: 'num' });
            cv.text(Calc.powerUnit(powerUnit), x + 27 + powerWidth, y + 137, 20, t.dim);
            cv.text(torqueText, split + 20, y + 137, 42, t.accent2, { font: 'num' });
            cv.text('Nm', split + 23 + torqueWidth, y + 137, 20, t.dim);
            cv.text('@ ' + formatNumber(run.peakPrpm, 0) + ' rpm', x + 24, y + 158, 16, t.dim);
            cv.text('@ ' + formatNumber(run.peakTrpm, 0) + ' rpm', split + 20, y + 158, 16, t.dim);
            drawDynoCurve(cv, t, run, x + 24, y + 166, w - 48, 19);
        }

        function drawEngine(cv, t, s) {
            const room = G.pageBottom(cv) - G.BOTTOM;
            const half = Math.round(room / 2);
            G.segBar(cv, t, 24, G.TOP, 1062, 226 + half, {
                label: 'Engine speed', value: s.rpm, unit: 'rpm', decimals: 0,
                min: 0, max: RPM_MAX, step: 500, scale: { every: 1000, div: 1000 },
                ramp: 'hot', peak: s.peaks.rpm,
            });
            G.segBar(cv, t, 24, G.TOP + 242 + half, 1062, 226 - half, {
                label: s.demo ? 'Boost · DEMO' : !s.boost ? 'Boost' : s.boost.source === 'BMW SPORT DISPLAY'
                    ? 'Boost · Sport Display · Approx.'
                    : 'Boost · DME Read-Only' + (s.boost.approximate ? ' · Baro estimate' : ''),
                value: s.boost ? s.boost.value : null, unit: 'bar', decimals: 2,
                min: 0, max: BOOST_MAX_BAR, step: 0.125, scale: { every: 0.5, decimals: 1 },
                ramp: 'hot', peak: s.peaks.boost,
            });

            drawDynoPanel(cv, t, s);

            const powerGaugeKw = settings.get('powerGaugeMax');
            const powerMax = Calc.powerValue(finite(powerGaugeKw) && powerGaugeKw > 0 ? powerGaugeKw : 223.7, s.powerUnit);
            const powerStep = Calc.scaleStep(powerMax, 5);
            const powerTicks = Calc.scaleTicks(powerMax, 5);
            const torqueGaugeMax = settings.get('torqueGaugeMax');
            const torqueMax = finite(torqueGaugeMax) && torqueGaugeMax > 0 ? torqueGaugeMax : 800;
            const torqueStep = Calc.scaleStep(torqueMax, 5);
            const torqueTicks = Calc.scaleTicks(torqueMax, 5);
            const powerText = !s.power ? '--' : (s.power.approximate ? '~' : '') + formatNumber(s.power.value, 0);
            G.bar(cv, t, 1110, G.TOP + 228, 466, 106, {
                label: 'HORSE POWER',
                value: s.power ? s.power.value : null, text: powerText,
                unit: Calc.powerUnit(s.powerUnit), min: 0, max: powerMax,
                step: powerStep, ticks: powerTicks,
                decimals: 0, peak: s.peaks.power, peakText: true, ramp: 'hot',
            });
            const torqueText = s.torque === null ? '--' : formatNumber(s.torque, 0);
            G.bar(cv, t, 1110, G.TOP + 358, 466, 106, {
                label: 'TORQUE', value: s.torque, text: torqueText, unit: 'Nm', min: 0, max: torqueMax,
                step: torqueStep, ticks: torqueTicks, decimals: 0,
                peak: s.peaks.torque, peakText: true, ramp: 'hot',
            });
        }

        async function render() {
            if (state.stopped) return;
            const demo = settings.get('demo') === 'on';
            const s = current(demo);
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            drawEngine(cv, t, s);
            G.frame(cv, t, ['Engine Data'], 0, demo
                ? [{ text: 'DEMO · NOT VEHICLE DATA', color: 'crit' }]
                : [{ text: 'READ ONLY', color: 'dim' }]);
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
            if (readOnlyLink) readOnlyLink.cancel();
            dynoRecorder.reset();
            subscriptions.splice(0).forEach(shutdownSubscription);
            diagLog('shutdown', { subscriptionsClosed: true, readOnlyQueueCancelled: true });
        }

        if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('shutdown', cleanup);
        settings.onChange((key) => {
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

        ctx.onTap((x, y) => {
            if (x < 1370 || x > 1558 || y < 24 || y > 102) return;
            const button = ui.rhmi && ui.rhmi.getByName && ui.rhmi.getByName('BTN_SETTINGS');
            if (button && typeof button.emit === 'function') button.emit('action', {});
        });
        ctx.onLayout(queueRender);
        diagLog('startup', { version: ctx.spec && ctx.spec.version || 'unknown', readOnly: true,
            rawDiagnostics: diagnostics(), dmeCandidates: settings.get('readDmeCandidates') === true });
        render().catch((e) => log.warn('first render: ' + shortError(e)));
    },
});
