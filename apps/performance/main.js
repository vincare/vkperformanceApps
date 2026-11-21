'use strict';

/**
 * Performance - read-only engine monitor for MGU / iDrive 7.
 *
 * HP is calculated from engine torque and RPM (so it is deliberately marked
 * approximate). Torque and Sport Display values come from FES SOME/IP.
 * DME boost uses absolute manifold pressure minus ambient pressure when both
 * read-only SGBD values answer; otherwise the OEM Sport Display boost is used
 * with its still-unverified scale clearly identified.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');

const W = 1600, H = 520;
const FRESH_MS = 4500;
const RENDER_MS = 90;
const DME_POLL_MS = 1200;
const DME_ECU = 0x12;
const PEAK_HOLD_MS = 15000;
const RPM_MAX = 8000;
const BOOST_MAX_BAR = 2.5;
const PRESSURE_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI', BAR: 'BAR', KPA: 'KPA', PSI: 'PSI' };

// Read-only UDS values from the repository's DME8FF_R catalog. The power
// DID's factor is present there, but its physical unit is not; it is logged
// for calibration and never shown as HP.
const DME = {
    power: { did: '4520', bytes: 2, factor: 0.015258789062, min: 0, max: 1000, timeoutMs: 700 },
    torque: { did: '5717', bytes: 2, signed: true, factor: 0.1, min: -1500, max: 1500, timeoutMs: 700 },
    manifold: { did: '4A2D', bytes: 2, factor: 0.078125, min: 0, max: 5120, timeoutMs: 700 },
    ambient: { did: '4201', bytes: 2, factor: 0.0390625, min: 0, max: 2560, timeoutMs: 700 },
};

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
        const state = {
            providers: Object.create(null),
            rpm: metric(), torqueFes: metric(), torqueDme: metric(),
            powerPct: metric(), torquePct: metric(),
            boostFes: metric(), manifold: metric(), ambient: metric(),
            pressureUnit: null, dmePower: metric(),
            stopped: false, dmeBusy: false, dmeReady: false,
        };
        const peaks = { live: Object.create(null), demo: Object.create(null) };
        const subscriptions = [];
        const diagnosticDedup = Object.create(null);
        let renderTimer = null, renderQueued = false, freshnessTimer = null, dmeTimer = null, demoTimer = null;
        let link = null, reader = null, dmeInit = null;

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
            const value = finite(raw) && raw >= 0 && raw < 65535 ? raw * 0.25 : null;
            updateMetric('rpm', raw, value, 'rpm', source, value === null ? 'invalid' : 'live');
        }

        function setFesTorque(payload, source) {
            const raw = payload && payload.actualValueTorqueCrankshaft;
            // Same empirically used M Vitals mapping: signed torque around raw 2047,
            // half a Nm per step; 4095 is the BMW invalid value.
            let value = finite(raw) && raw >= 0 && raw < 4095 ? raw * 0.5 - 1023.5 : null;
            if (finite(value)) value = Math.max(0, value);
            updateMetric('torqueFes', raw, value, 'Nm', source, value === null ? 'invalid' : 'live');
        }

        function setFesPercentages(payload, source) {
            const power = payload && payload.displaySportEnginePower;
            const torque = payload && payload.displaySportEngineTorque;
            const p = finite(power) && power >= 0 && power <= 100 ? power : null;
            const t = finite(torque) && torque >= 0 && torque <= 100 ? torque : null;
            updateMetric('powerPct', power, p, '%', source, p === null ? 'invalid' : 'live');
            updateMetric('torquePct', torque, t, '%', source, t === null ? 'invalid' : 'live');
        }

        function setFesBoost(payload, source) {
            const raw = payload && payload.displayBoostPressure;
            const value = finite(raw) && raw >= 0 && raw < 255 ? convertFesBoost(raw) : null;
            const unit = state.pressureUnit ? 'bar' : 'unknown';
            updateMetric('boostFes', raw, value, unit, source, value === null ? (raw === 255 ? 'invalid' : 'unit-unknown') : 'live');
        }

        function convertFesBoost(raw) {
            if (!finite(raw) || !state.pressureUnit) return null;
            let bar;
            if (state.pressureUnit === 'PSI') bar = raw * 0.1 / 14.5038;
            else bar = raw * 0.01; // BAR: .01 bar/bit; KPA: 1 kPa/bit = .01 bar/bit.
            return finite(bar) && bar >= 0 && bar <= 4.5 ? bar : null;
        }

        function setPressureUnits(payload, source) {
            const raw = payload && payload.unitOfMeasurementAirPressure;
            const unit = pressureUnit(raw);
            state.pressureUnit = unit;
            diagLog('pressure_units', { source, raw, unit: unit || 'unknown' });
            if (state.boostFes.at) setFesBoost({ displayBoostPressure: state.boostFes.raw }, 'reconvert');
            queueRender();
        }

        function logRawOnly(name, payload, source) {
            const rec = { raw: payload, source: source || 'event', unit: 'unverified' };
            const key = 'raw:' + name, signature = json(rec), now = Date.now(), old = diagnosticDedup[key];
            if (diagnostics() && (!old || old.signature !== signature || now - old.at >= 30000)) {
                diagnosticDedup[key] = { signature, at: now };
                diagLog('payload', { signal: name, raw: payload, unit: 'unverified', source: source || 'event' });
            }
        }

        const CDS = 'de.bmw.infotainment.vehicle.CDS';
        const VEHICLE = 'de.bmw.infotainment.vehicle.Vehicle';
        const FES = 'de.bmw.infotainment.drivingexcitement.FES';
        startWatch(CDS, { statusEngineSpeed2: setRpm });
        startWatch(VEHICLE, { statusNewCurrentUnitsStatusExt: setPressureUnits });
        startWatch(FES, {
            statusActualValueTorque2: setFesTorque,
            statusVehicleDynamicEngine: setFesPercentages,
            statusVehicleDynamicEngineMaxValue: (v, source) => logRawOnly('FES.statusVehicleDynamicEngineMaxValue', v, source),
            statusVehicleDynamicEngineScaling: (v, source) => logRawOnly('FES.statusVehicleDynamicEngineScaling', v, source),
            statusSwitchDriveDynamicSport2: setFesBoost,
            displaySportPowertrain: (v, source) => logRawOnly('FES.displaySportPowertrain', v, source),
        });

        // Read-only DME candidates: only ISO-TP/UDS 0x22 ReadDataByIdentifier.
        // There are no setter, reset, session, or actuation calls in this app.
        const readOnlyLink = new ReadOnlyDiag(ctx.signals, log, { gapMs: 80, silentAfter: 3 });
        reader = new DidReader(readOnlyLink, { ecu: DME_ECU });
        async function initDme() {
            if (dmeInit) return dmeInit;
            dmeInit = Promise.resolve().then(() => readOnlyLink.init()).then(() => {
                state.dmeReady = readOnlyLink.ready;
                diagLog('dme_link_ready', { ready: state.dmeReady, error: readOnlyLink.error || null, ecu: DME_ECU });
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
                settings.get('readDmeCandidates') !== true || !diagnostics()) return;
            if (!fresh(state.rpm, now) || state.rpm.value < 500 || now - lastDmeCycle < DME_POLL_MS) return;
            lastDmeCycle = now;
            state.dmeBusy = true;
            try {
                if (!await initDme()) return;
                const jobs = [
                    ['power', DME.power], ['torque', DME.torque],
                    ['manifold', DME.manifold], ['ambient', DME.ambient],
                ];
                for (const [name, candidate] of jobs) {
                    if (state.stopped) break;
                    const value = await reader.read(candidate);
                    const result = reader.raws[reader.key(candidate)] || {};
                    const rawBytes = result.bytes || result.why || (value === null ? 'no reply' : null);
                    if (name === 'power') {
                        updateMetric('dmePower', rawBytes, value, 'unit unverified', 'DME DID 4520', value === null ? 'unavailable' : 'live');
                    } else if (name === 'torque') {
                        updateMetric('torqueDme', rawBytes, value === null ? null : Math.max(0, value), 'Nm', 'DME DID 5717', value === null ? 'unavailable' : 'live');
                    } else if (name === 'manifold') {
                        updateMetric('manifold', rawBytes, value, 'hPa abs', 'DME DID 4A2D', value === null ? 'unavailable' : 'live');
                    } else {
                        updateMetric('ambient', rawBytes, value, 'hPa abs', 'DME DID 4201', value === null ? 'unavailable' : 'live');
                    }
                    if (value === null) diagLog('dme_candidate_unavailable', { did: candidate.did, why: result.why || 'no reply', response: result.bytes || '' });
                }
            } catch (e) {
                diagLog('dme_poll_error', { error: shortError(e) });
                log.warn('DME poll: ' + shortError(e));
            } finally {
                state.dmeBusy = false;
            }
        }

        function selectTorque(now) {
            if (fresh(state.torqueFes, now)) return { value: state.torqueFes.value, source: 'BMW SPORT SIGNAL' };
            if (fresh(state.torqueDme, now)) return { value: state.torqueDme.value, source: 'DME READ-ONLY' };
            return null;
        }

        function boostValue(now) {
            if (fresh(state.manifold, now) && fresh(state.ambient, now)) {
                const hpa = state.manifold.value - state.ambient.value;
                const bar = Math.max(0, hpa / 1000);
                if (finite(bar) && bar <= 4.5) return { value: bar, approximate: false, source: 'DME GAUGE · MANIFOLD − AMBIENT' };
            }
            if (fresh(state.boostFes, now)) return { value: state.boostFes.value, approximate: true, source: 'BMW SPORT DISPLAY · SCALE CHECK PENDING' };
            return null;
        }

        function current(demo) {
            const now = Date.now();
            if (demo) {
                const sec = now / 1000;
                const rpm = 1800 + 5200 * (0.5 + 0.5 * Math.sin(sec * 0.34));
                const torque = 450 + 180 * Math.max(0, Math.sin(sec * 0.34 - 0.7));
                const hp = torque * rpm / 7127.2;
                const boost = { value: 0.3 + 1.2 * Math.max(0, Math.sin(sec * 0.34)), approximate: true, source: 'DEMO' };
                const result = {
                    demo: true, rpm, torque, torqueSource: 'DEMO', hp,
                    powerPct: Math.min(100, hp / 5.5), torquePct: Math.min(100, torque / 7),
                    boost,
                };
                result.peaks = peakValues('demo', result, now);
                return result;
            }
            const rpm = fresh(state.rpm, now) ? state.rpm.value : null;
            const tq = selectTorque(now);
            const hp = rpm !== null && tq ? Math.max(0, tq.value) * rpm / 7127.2 : null;
            const result = {
                demo: false, rpm, torque: tq ? tq.value : null, torqueSource: tq ? tq.source : null, hp,
                powerPct: fresh(state.powerPct, now) ? state.powerPct.value : null,
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
                rpm: peak('rpm', values.rpm), hp: peak('hp', values.hp),
                torque: peak('torque', values.torque), powerPct: peak('powerPct', values.powerPct),
                torquePct: peak('torquePct', values.torquePct), boost: peak('boost', values.boost && values.boost.value),
            };
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
                label: !s.boost ? 'Boost' : s.boost.approximate ? 'Boost · Sport Display · Approx.' : 'Boost · DME Read-Only',
                value: s.boost ? s.boost.value : null, unit: 'bar', decimals: 2,
                min: 0, max: BOOST_MAX_BAR, step: 0.125, scale: { every: 0.5, decimals: 1 },
                ramp: 'hot', peak: s.peaks.boost,
            });

            G.panel(cv, t, 1110, G.TOP, 466, 190, 'BMW Sport Display');
            G.bar(cv, t, 1132, G.TOP + 48, 422, 58, {
                label: 'Power scale', value: s.powerPct, unit: '%', min: 0, max: 100,
                step: 20, decimals: 0, peak: s.peaks.powerPct, ramp: 'hot',
            });
            G.bar(cv, t, 1132, G.TOP + 116, 422, 58, {
                label: 'Torque scale', value: s.torquePct, unit: '%', min: 0, max: 100,
                step: 20, decimals: 0, peak: s.peaks.torquePct, ramp: 'hot',
            });

            const hpText = s.hp === null ? '--' : '~' + formatNumber(s.hp, 0);
            G.bar(cv, t, 1110, G.TOP + 228, 466, 106, {
                label: 'Power · estimated', value: s.hp, text: hpText, unit: 'hp', min: 0, max: 600,
                step: 100, decimals: 0, peak: s.peaks.hp, peakText: true, ramp: 'hot',
            });
            const torqueText = s.torque === null ? '--' : formatNumber(s.torque, 0);
            G.bar(cv, t, 1110, G.TOP + 358, 466, 106, {
                label: 'Engine torque', value: s.torque, text: torqueText, unit: 'Nm', min: 0, max: 800,
                step: 100, decimals: 0, peak: s.peaks.torque, peakText: true, ramp: 'hot',
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
            subscriptions.splice(0).forEach(shutdownSubscription);
            diagLog('shutdown', { subscriptionsClosed: true, readOnlyQueueCancelled: true });
        }

        if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('shutdown', cleanup);
        settings.onChange((key) => {
            if (key === 'demo' && settings.get('demo') === 'on' && !demoTimer) demoTimer = setInterval(queueRender, 250);
            if (key === 'demo' && settings.get('demo') !== 'on' && demoTimer) { clearInterval(demoTimer); demoTimer = null; }
            queueRender();
        });
        if (settings.get('demo') === 'on') demoTimer = setInterval(queueRender, 250);
        freshnessTimer = setInterval(queueRender, 1000);
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
