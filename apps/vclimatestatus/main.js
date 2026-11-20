'use strict';

/**
 * VClimateStatus: read-only BMW MGU climate monitor.
 *
 * ClimateMaster.statusTemperature is catalog-confirmed as an array of
 * StatusTemperature records. Each record carries targetTemperature (Float)
 * and operationZone. Its unit/scale is not stated in the catalog, so live
 * values are intentionally shown without a °C suffix until verified in-car.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');

const W = 1600, H = 520;
const NO_PAYLOAD_MS = 30000;
const SAME_PAYLOAD_LOG_MS = 30000;
const C = {
    bg: '#090909', card: '#171717', border: '#292929',
    red: '#E02020', darkRed: '#8B1010', white: '#FFFFFF', muted: '#969696',
    green: '#58C98B',
};
const SIGNAL_POLL_MS = 5000;
const SIGNAL_STALE_MS = 15000;
const ZONE_NAMES = { 1: 'driver', 2: 'passenger', DRIVER: 'driver', PASSENGER: 'passenger' };

function findValues(value, key, out) {
    out = out || [];
    if (!value || typeof value !== 'object') return out;
    if (Object.prototype.hasOwnProperty.call(value, key)) out.push(value[key]);
    else Object.keys(value).forEach((name) => findValues(value[name], key, out));
    return out;
}

function acState(value) {
    const states = findValues(value, 'statusAircon');
    if (!states.length) return null;
    const state = states[0];
    if (state === 1 || state === 'KLIMAANLAGE_EIN') return true;
    if (state === 0 || state === 'KLIMAANLAGE_AUS') return false;
    return null;
}

function temperatureRecords(value, out, seen, depth) {
    out = out || [];
    seen = seen || [];
    depth = depth || 0;
    if (!value || typeof value !== 'object' || depth > 12 || seen.indexOf(value) >= 0) return out;
    seen.push(value);
    if (Array.isArray(value)) {
        value.forEach((item) => temperatureRecords(item, out, seen, depth + 1));
    } else if (Object.prototype.hasOwnProperty.call(value, 'targetTemperature') &&
        Object.prototype.hasOwnProperty.call(value, 'operationZone')) {
        out.push(value);
    } else {
        Object.keys(value).forEach((key) => temperatureRecords(value[key], out, seen, depth + 1));
    }
    return out;
}

function hasPayloadContent(value, seen) {
    if (value === null || value === undefined) return false;
    if (typeof value !== 'object') return true;
    seen = seen || [];
    if (seen.indexOf(value) >= 0) return false;
    seen.push(value);
    return Object.keys(value).some((key) => hasPayloadContent(value[key], seen));
}

function zoneName(value) {
    if (typeof value === 'number' && (value === 1 || value === 2)) return ZONE_NAMES[value];
    if (typeof value === 'string') return ZONE_NAMES[value.trim().toUpperCase()] || null;
    return null;
}

function diagnosticValue(value) {
    if (typeof value === 'number' && !isFinite(value)) return String(value);
    if (value === undefined) return 'undefined';
    try {
        const text = JSON.stringify(value);
        return text === undefined ? String(value) : text;
    } catch (e) {
        return '[unserializable]';
    }
}

function temperatureDisplay(value, showUnit) {
    if (typeof value === 'number' && isFinite(value)) {
        const rounded = Math.round(value * 10) / 10;
        const text = Math.abs(rounded - Math.round(rounded)) < 0.05 ? String(Math.round(rounded)) : rounded.toFixed(1);
        return { text, size: 104, font: 'num', color: C.white, unit: !!showUnit };
    }
    if (typeof value === 'string') {
        const text = value.trim().toUpperCase();
        if (text === 'HI' || text === 'LO') return { text, size: 104, font: 'bold', color: C.white, unit: false };
    }
    return { text: '--', size: 91, font: 'num', color: '#777777', unit: !!showUnit };
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const diagnosticsEnabled = settings.get('climateDiagnostics') === true;
        const live = {
            ac: null, signalError: false, signalAvailable: false,
            seenAc: false, invalidAc: false, stale: false,
            setpointAvailable: false,
            zones: {
                driver: { value: null, state: 'waiting', lastSeen: 0 },
                passenger: { value: null, state: 'waiting', lastSeen: 0 },
            },
        };
        let renderQueued = false, renderTimer = null, staleTimer = null, freshnessTimer = null;
        let noPayloadTimer = null;
        let stopped = false;
        const subscriptions = [];
        let lastSetpointAvailability;
        let setpointWatchResolved = false;
        let payloadCount = 0, lastPayloadSignature = null, lastPayloadLoggedAt = 0;
        const lastDiagnosticLog = Object.create(null);

        log.info('CLIMATE_DIAG startup version=' + (ctx.spec && ctx.spec.version || 'unknown') +
            ' enabled=' + (diagnosticsEnabled ? 'true' : 'false'));

        function climateDiag(stage, detail, level) {
            if (!diagnosticsEnabled) return;
            let info = '';
            if (detail) {
                Object.keys(detail).forEach((key) => {
                    let value = diagnosticValue(detail[key]).replace(/[\r\n]+/g, ' ');
                    if (value.length > 260) value = value.slice(0, 257) + '...';
                    info += ' ' + key + '=' + value;
                });
            }
            const method = level || (/error|failed|missing/i.test(stage) ? 'warn' : 'info');
            log[method]('CLIMATE_DIAG at=' + new Date().toISOString() + ' stage=' + stage + info);
        }

        function clearNoPayloadTimer() {
            if (noPayloadTimer) { clearTimeout(noPayloadTimer); noPayloadTimer = null; }
        }

        function armNoPayloadTimer() {
            if (!diagnosticsEnabled || payloadCount || stopped) return;
            clearNoPayloadTimer();
            noPayloadTimer = setTimeout(() => {
                noPayloadTimer = null;
                climateDiag('no_payload_timeout', {
                    waitSeconds: NO_PAYLOAD_MS / 1000,
                    providerAvailable: live.setpointAvailable,
                    watchResolved: setpointWatchResolved,
                });
            }, NO_PAYLOAD_MS);
        }

        function diagnosticSignalEvent(event) {
            if (!event || !diagnosticsEnabled) return;
            // Raw payloads are logged below with the corresponding event/getter source.
            // Avoid a second line for every successful 5-second getter poll.
            if (event.stage === 'payload_received' || event.stage === 'getter_started' ||
                event.stage === 'provider_availability') return;
            if (event.stage === 'getter_error') {
                const detail = event.detail || {};
                const signature = String(detail.field || '') + ':' + String(detail.error || '');
                const now = Date.now();
                if (lastDiagnosticLog[signature] && now - lastDiagnosticLog[signature] < SAME_PAYLOAD_LOG_MS) return;
                lastDiagnosticLog[signature] = now;
            }
            climateDiag('signal_' + event.stage, Object.assign({
                iface: event.iface,
                instance: event.instance,
            }, event.detail || {}));
        }

        function logTemperaturePayload(value, source, records, now) {
            if (!diagnosticsEnabled) return;
            payloadCount++;
            clearNoPayloadTimer();
            const signature = (source || 'unknown') + ':' + (records.length ? records.map((record) =>
                diagnosticValue(record.operationZone) + ':' + diagnosticValue(record.targetTemperature) + ':' +
                diagnosticValue(record.saveLUM)).join('|') : diagnosticValue(value).slice(0, 500));
            if (signature === lastPayloadSignature && now - lastPayloadLoggedAt < SAME_PAYLOAD_LOG_MS) return;
            lastPayloadSignature = signature;
            lastPayloadLoggedAt = now;
            const receivedAt = new Date(now).toISOString();
            if (records.length) {
                records.forEach((record, index) => {
                    const mapped = zoneName(record.operationZone);
                    log.info('CLIMATE_DIAG statusTemperature rx=' + receivedAt +
                        ' source=' + (source || 'unknown') + ' record=' + index +
                        ' zoneRaw=' + diagnosticValue(record.operationZone) +
                        ' zone=' + (mapped ? mapped.toUpperCase() : 'UNMAPPED') +
                        ' targetRaw=' + diagnosticValue(record.targetTemperature) +
                        ' saveLUMRaw=' + diagnosticValue(record.saveLUM));
                });
            } else {
                let raw = diagnosticValue(value);
                if (raw.length > 500) raw = raw.slice(0, 497) + '...';
                log.info('CLIMATE_DIAG statusTemperature rx=' + receivedAt +
                    ' source=' + (source || 'unknown') + ' records=0 payloadRaw=' + raw);
            }
        }

        armNoPayloadTimer();

        // DEMO is only a host preview mode. The car runtime does not expose
        // ctx.preview, and the installed manifest declares no demo setting.
        function isDemo() {
            return ctx.preview === true && ctx.signals &&
                typeof ctx.signals.hasNative === 'function' && !ctx.signals.hasNative() &&
                settings.get('demo') === 'on';
        }

        function clearStaleTimer() {
            if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
        }

        function onSetpointAvailability(available) {
            if (stopped) return;
            const current = !!available;
            if (lastSetpointAvailability !== current) {
                lastSetpointAvailability = current;
                climateDiag('setpoint_provider_availability', { available: current });
                if (current && !payloadCount) armNoPayloadTimer();
            }
            live.setpointAvailable = current;
            Object.keys(live.zones).forEach((name) => {
                const zone = live.zones[name];
                if (!available) {
                    zone.value = null;
                    zone.lastSeen = 0;
                    zone.state = 'unavailable';
                } else if (zone.state === 'unavailable') {
                    zone.state = 'waiting';
                }
            });
            queueRender();
        }

        function onTemperatureSignal(value, source) {
            if (stopped) return;
            onSetpointAvailability(true);
            const records = temperatureRecords(value);
            const now = Date.now();
            logTemperaturePayload(value, source, records, now);
            if (!records.length && hasPayloadContent(value)) {
                Object.keys(live.zones).forEach((name) => {
                    live.zones[name].value = null;
                    live.zones[name].lastSeen = now;
                    live.zones[name].state = 'invalid';
                });
                queueRender();
                return;
            }
            records.forEach((record) => {
                const name = zoneName(record.operationZone);
                if (!name) return; // Ignore ALL_ZONES and the second/third row enum values.
                const zone = live.zones[name];
                zone.lastSeen = now;
                if (typeof record.targetTemperature === 'number' && isFinite(record.targetTemperature)) {
                    zone.value = record.targetTemperature;
                    zone.state = 'live';
                } else {
                    zone.value = null;
                    zone.state = 'invalid';
                }
            });
            queueRender();
        }

        function checkSetpointFreshness() {
            if (stopped || !live.setpointAvailable) return;
            const now = Date.now();
            let changed = false;
            Object.keys(live.zones).forEach((name) => {
                const zone = live.zones[name];
                if (zone.lastSeen && now - zone.lastSeen > SIGNAL_STALE_MS && zone.state !== 'stale') {
                    zone.value = null;
                    zone.state = 'stale';
                    changed = true;
                }
            });
            if (changed) queueRender();
        }

        freshnessTimer = setInterval(checkSetpointFreshness, 3000);

        function armStaleTimer() {
            clearStaleTimer();
            live.stale = false;
            staleTimer = setTimeout(() => {
                staleTimer = null;
                if (stopped || !live.signalAvailable) return;
                live.stale = true;
                live.ac = null;
                queueRender();
            }, SIGNAL_STALE_MS);
        }

        function onAvailability(available) {
            if (stopped) return;
            live.signalAvailable = !!available;
            if (live.signalAvailable) armStaleTimer();
            else {
                clearStaleTimer();
                live.ac = null;
                live.stale = true;
            }
            queueRender();
        }

        function onAcSignal(value) {
            if (stopped) return;
            live.seenAc = true;
            live.signalAvailable = true;
            live.ac = acState(value);
            live.invalidAc = live.ac === null;
            armStaleTimer();
            queueRender();
        }

        function cleanup() {
            if (stopped) return;
            stopped = true;
            if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
            clearStaleTimer();
            clearNoPayloadTimer();
            if (freshnessTimer) { clearInterval(freshnessTimer); freshnessTimer = null; }
            const subs = subscriptions.splice(0);
            subs.forEach((sub) => {
                if (sub && typeof sub.shutdown === 'function') Promise.resolve().then(() => sub.shutdown()).catch((e) => {
                    log.warn('signal shutdown: ' + (e && e.message || e));
                });
            });
        }

        // kit/runtime/mgu.js exposes the actual OAP OnlineApp EventEmitter in
        // ctx.app and gives this handler 200 ms before its final process exit.
        if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('shutdown', cleanup);

        let watch;
        try {
            watch = ctx.signals.watch(
                'de.bmw.infotainment.climate.Climate2', '1',
                { statusACFront: onAcSignal }, log,
                { pollMs: SIGNAL_POLL_MS, onAvailability }
            );
        } catch (e) {
            live.signalError = true;
            log.warn('A/C status signal: ' + (e && e.message || e));
        }
        Promise.resolve(watch).then((result) => {
            if (!result) return;
            subscriptions.push(result);
            if (stopped) {
                subscriptions.splice(subscriptions.indexOf(result), 1);
                cleanupSubscription(result);
                return;
            }
            if (result.error) {
                live.signalError = true;
                live.signalAvailable = false;
                live.stale = true;
                log.warn('A/C status signal: ' + result.error);
                queueRender();
            } else if (typeof result.available === 'boolean') {
                onAvailability(result.available);
            }
        }).catch((e) => {
            if (stopped) return;
            live.signalError = true;
            live.signalAvailable = false;
            live.stale = true;
            log.warn('A/C status signal: ' + (e && e.message || e));
            queueRender();
        });

        let setpointWatch;
        try {
            setpointWatch = ctx.signals.watch(
                'de.bmw.infotainment.climate.climatemaster.ClimateMaster', '1',
                { statusTemperature: onTemperatureSignal }, log,
                {
                    pollMs: SIGNAL_POLL_MS,
                    onAvailability: onSetpointAvailability,
                    onDiagnostic: diagnosticsEnabled ? diagnosticSignalEvent : undefined,
                }
            );
        } catch (e) {
            climateDiag('watch_call_error', { error: e && e.message || e });
            log.warn('setpoint signal: ' + (e && e.message || e));
        }
        Promise.resolve(setpointWatch).then((result) => {
            setpointWatchResolved = true;
            if (!result) {
                climateDiag('watch_completed', { result: 'no-result' });
                return;
            }
            subscriptions.push(result);
            if (stopped) {
                subscriptions.splice(subscriptions.indexOf(result), 1);
                cleanupSubscription(result);
                return;
            }
            climateDiag('watch_completed', { error: result.error || 'none', available: result.available === true });
            if (result.error) {
                onSetpointAvailability(false);
                log.warn('setpoint signal: ' + result.error);
            } else if (typeof result.available === 'boolean') {
                onSetpointAvailability(result.available);
            }
        }).catch((e) => {
            if (stopped) return;
            setpointWatchResolved = true;
            climateDiag('watch_rejected', { error: e && e.message || e });
            onSetpointAvailability(false);
            log.warn('setpoint signal: ' + (e && e.message || e));
        });

        function cleanupSubscription(sub) {
            if (sub && typeof sub.shutdown === 'function') {
                Promise.resolve().then(() => sub.shutdown()).catch((e) => {
                    log.warn('signal shutdown: ' + (e && e.message || e));
                });
            }
        }

        function state() {
            if (isDemo()) {
                // preview.js can override these transient values to inspect
                // special display cases; no such settings are in app.json.
                const previewValue = (key, fallback) => {
                    const value = settings.get(key);
                    return value === undefined ? fallback : value;
                };
                return {
                    demo: true,
                    driver: previewValue('demoDriver', 22),
                    passenger: previewValue('demoPassenger', 21),
                    driverStatus: 'demo', passengerStatus: 'demo',
                    ac: true,
                };
            }
            return {
                demo: false,
                driver: live.zones.driver.state === 'live' ? live.zones.driver.value : null,
                passenger: live.zones.passenger.state === 'live' ? live.zones.passenger.value : null,
                driverStatus: live.zones.driver.state,
                passengerStatus: live.zones.passenger.state,
                ac: live.ac,
            };
        }

        function badge(cv, label, demo) {
            const x = 1394, y = 52, w = 126, h = 42;
            cv.roundRect(x, y, w, h, 8, demo ? C.darkRed : '#202020');
            cv.fillRect(x, y + 8, 4, h - 16, demo ? C.red : C.green);
            cv.text(label, x + w / 2 + 2, y + 27, 18, C.white, { align: 'center', font: 'bold', spacing: 2 });
        }

        function climateCard(cv, x, title, value, demo, signalStatus) {
            const y = 160, w = 700, h = 274;
            cv.roundRect(x, y, w, h, 12, C.card);
            cv.fillRect(x, y + 20, 5, h - 40, C.red);
            cv.fillRect(x + 38, y + 58, 44, 4, C.red);
            cv.text(title, x + 38, y + 42, 22, C.white, { font: 'bold', spacing: 3 });
            cv.text('SET TEMPERATURE', x + 38, y + 91, 17, C.muted, { font: 'bold', spacing: 2 });

            const shown = temperatureDisplay(value, demo);
            const maxWidth = w - 76;
            let size = shown.size;
            const unitSize = 34, gap = 13;
            const unitWidth = shown.unit ? cv.textWidth('°C', unitSize, { font: 'bold' }) : 0;
            while (size > 24 && cv.textWidth(shown.text, size, { font: shown.font }) +
                (shown.unit ? gap + unitWidth : 0) > maxWidth) size -= 2;
            const valueWidth = cv.textWidth(shown.text, size, { font: shown.font });
            const valueX = x + 38;
            cv.text(shown.text, valueX, y + 198, size, shown.color, { font: shown.font });
            if (shown.unit) cv.text('°C', valueX + valueWidth + gap, y + 194, unitSize, C.muted, { font: 'bold' });
            cv.fillRect(x + 38, y + 224, w - 76, 1, C.border);
            const labels = {
                demo: 'LOCAL PREVIEW VALUE', live: 'LIVE VALUE · UNIT UNVERIFIED',
                waiting: 'WAITING FOR SIGNAL', stale: 'SIGNAL STALE',
                invalid: 'INVALID SIGNAL', unavailable: 'SIGNAL UNAVAILABLE',
            };
            const statusText = labels[demo ? 'demo' : signalStatus] || 'SIGNAL UNAVAILABLE';
            cv.text(statusText, x + 38, y + 257, 15, demo ? C.red : signalStatus === 'live' ? C.green : C.muted, { font: 'bold', spacing: 1.3 });
        }

        async function render() {
            if (stopped) return;
            const s = state();
            const cv = ctx.canvas(W, H).clear(C.bg);

            cv.fillRect(48, 50, 5, 76, C.red);
            cv.text('VKPERFORMANCE', 72, 72, 16, C.red, { font: 'bold', spacing: 2.5 });
            cv.text('VClimateStatus', 72, 112, 31, C.white, { font: 'bold', spacing: 0.4 });
            badge(cv, s.demo ? 'DEMO' : (live.signalAvailable || live.setpointAvailable) ? 'LIVE' : 'WAIT', s.demo);
            cv.fillRect(48, 139, 1472, 1, C.border);

            climateCard(cv, 72, 'DRIVER', s.driver, s.demo, s.driverStatus);
            climateCard(cv, 828, 'PASSENGER', s.passenger, s.demo, s.passengerStatus);

            cv.fillRect(72, 464, 1456, 1, C.border);
            cv.text('CLIMATE STATUS', 72, 499, 15, C.muted, { font: 'bold', spacing: 1.8 });
            const signalUnavailable = live.signalError || !live.signalAvailable || live.stale || live.invalidAc;
            const acText = s.demo ? 'A/C ON' : signalUnavailable ? 'SIGNAL UNAVAILABLE' :
                !live.seenAc ? 'WAITING FOR DATA' : s.ac === null ? 'SIGNAL UNAVAILABLE' : s.ac ? 'A/C ON' : 'A/C OFF';
            cv.fillRect(267, 483, 5, 16, s.ac === true ? C.red : C.muted);
            cv.text(acText, 286, 499, 17, s.ac === true ? C.white : C.muted, { font: 'bold', spacing: 1.1 });
            const zoneStates = Object.keys(live.zones).map((name) => live.zones[name].state);
            const hasLiveTemperature = zoneStates.indexOf('live') >= 0;
            const sourceText = s.demo ? 'DEMO VALUES · NOT VEHICLE DATA' :
                hasLiveTemperature ? 'VEHICLE VALUE · UNIT UNVERIFIED' :
                    zoneStates.indexOf('invalid') >= 0 ? 'INVALID SETPOINT PAYLOAD' :
                        zoneStates.indexOf('stale') >= 0 ? 'SETPOINT DATA STALE' :
                            live.setpointAvailable ? 'WAITING FOR SETPOINT DATA' : 'SETPOINT SIGNAL · UNAVAILABLE';
            cv.text(sourceText, 1528, 499, 15, s.demo ? C.red : C.muted, { align: 'right', spacing: 0.7 });

            G.frame(cv, ctx.theme(), ['Climate'], 0);
            return ui.image('MAIN_GFX', cv);
        }

        function queueRender() {
            if (stopped || renderQueued) return;
            renderQueued = true;
            renderTimer = setTimeout(() => {
                renderQueued = false;
                renderTimer = null;
                render().catch((e) => log.warn('render: ' + (e && e.message || e)));
            }, 35);
        }

        ctx.onLayout(queueRender);
        render().catch((e) => log.warn('first render: ' + (e && e.message || e)));
    },
});
