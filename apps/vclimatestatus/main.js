'use strict';

/**
 * Climate Control: read-only BMW MGU climate status display.
 *
 * Climate2's driver/passenger status payloads carry BMW's raw IHKA target
 * values. The source app's decoder maps values 32..56 to Celsius by dividing
 * by two. ClimateMaster.statusTemperature remains as an unscaled fallback.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');

const W = 1600, H = 520;
const NO_PAYLOAD_MS = 30000;
const SAME_PAYLOAD_LOG_MS = 30000;
const C = {
    bg: '#050505', card: '#0B090A', border: '#351014',
    red: '#F02A38', redDim: '#62151D', redFaint: '#351014',
    white: '#FFFFFF', muted: '#A4A0A1', faint: '#686365',
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
            setpointAvailable: false, climate2SetpointAvailable: false,
            masterSetpointAvailable: false,
            zones: {
                driver: { value: null, state: 'waiting', lastSeen: 0, unitC: false, source: null, priority: 0 },
                passenger: { value: null, state: 'waiting', lastSeen: 0, unitC: false, source: null, priority: 0 },
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
            live.masterSetpointAvailable = current;
            updateSetpointAvailability();
        }

        function updateSetpointAvailability() {
            live.setpointAvailable = live.masterSetpointAvailable || live.climate2SetpointAvailable;
            Object.keys(live.zones).forEach((name) => {
                const zone = live.zones[name];
                if (zone.lastSeen) return;
                zone.state = live.setpointAvailable ? 'waiting' : 'unavailable';
            });
            queueRender();
        }

        function applyZoneValue(name, value, source, priority, unitC) {
            const zone = live.zones[name];
            if (!zone) return;
            const now = Date.now();
            const previousIsFresh = zone.lastSeen && now - zone.lastSeen <= SIGNAL_STALE_MS;
            if (previousIsFresh && zone.priority > priority) return;
            zone.value = value;
            zone.state = 'live';
            zone.lastSeen = now;
            zone.unitC = !!unitC;
            zone.source = source;
            zone.priority = priority;
        }

        function applyZoneInvalid(name, source, priority) {
            const zone = live.zones[name];
            if (!zone) return;
            const now = Date.now();
            const previousIsFresh = zone.lastSeen && now - zone.lastSeen <= SIGNAL_STALE_MS;
            if (previousIsFresh && (zone.priority > priority || zone.state === 'live')) return;
            zone.value = null;
            zone.state = 'invalid';
            zone.lastSeen = now;
            zone.unitC = false;
            zone.source = source;
            zone.priority = priority;
        }

        function decodedIhkaTemperature(value, field, zoneNameValue) {
            if (stopped) return;
            const found = findValues(value, field);
            if (!found.length) return;
            onClimate2SetpointAvailability(true);
            const raw = found[0];
            const valid = typeof raw === 'number' && isFinite(raw) && raw >= 32 && raw <= 56;
            const now = Date.now();
            if (diagnosticsEnabled) {
                payloadCount++;
                clearNoPayloadTimer();
                const signature = field + ':' + diagnosticValue(raw);
                if (signature !== lastPayloadSignature || now - lastPayloadLoggedAt >= SAME_PAYLOAD_LOG_MS) {
                    lastPayloadSignature = signature;
                    lastPayloadLoggedAt = now;
                    climateDiag('ihka_setpoint', {
                        zone: zoneNameValue.toUpperCase(), field: field,
                        raw: raw, decodedC: valid ? raw / 2 : 'unavailable', source: 'Climate2',
                    });
                }
            }
            if (valid) applyZoneValue(zoneNameValue, raw / 2, 'IHKA', 2, true);
            else applyZoneInvalid(zoneNameValue, 'IHKA', 2);
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
                    applyZoneInvalid(name, 'ClimateMaster', 1);
                });
                queueRender();
                return;
            }
            records.forEach((record) => {
                const name = zoneName(record.operationZone);
                if (!name) return; // Ignore ALL_ZONES and the second/third row enum values.
                if (typeof record.targetTemperature === 'number' && isFinite(record.targetTemperature)) {
                    applyZoneValue(name, record.targetTemperature, 'ClimateMaster', 1, false);
                } else {
                    applyZoneInvalid(name, 'ClimateMaster', 1);
                }
            });
            queueRender();
        }

        function checkSetpointFreshness() {
            if (stopped) return;
            const now = Date.now();
            let changed = false;
            Object.keys(live.zones).forEach((name) => {
                const zone = live.zones[name];
                if (zone.lastSeen && now - zone.lastSeen > SIGNAL_STALE_MS && zone.state !== 'stale') {
                    zone.value = null;
                    zone.state = 'stale';
                    zone.unitC = false;
                    zone.source = null;
                    zone.priority = 0;
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

        function onClimate2SetpointAvailability(available) {
            if (stopped) return;
            const current = !!available;
            if (live.climate2SetpointAvailable !== current) {
                live.climate2SetpointAvailable = current;
                climateDiag('ihka_setpoint_provider_availability', { available: current });
                if (current && !payloadCount) armNoPayloadTimer();
            }
            updateSetpointAvailability();
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
                {
                    statusACFront: onAcSignal,
                    statusAirConditionDRStatus: (value) => decodedIhkaTemperature(
                        value, 'temperatureTargetDRIHKA', 'driver'),
                    statusAirConditionPSStatus: (value) => decodedIhkaTemperature(
                        value, 'temperatureTargetPSIHKA', 'passenger'),
                }, log,
                {
                    pollMs: SIGNAL_POLL_MS,
                    onAvailability: (available) => {
                        onAvailability(available);
                        onClimate2SetpointAvailability(available);
                    },
                    onDiagnostic: diagnosticsEnabled ? diagnosticSignalEvent : undefined,
                }
            );
        } catch (e) {
            live.signalError = true;
            log.warn('A/C status signal: ' + (e && e.message || e));
            onClimate2SetpointAvailability(false);
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
                onClimate2SetpointAvailability(false);
                log.warn('A/C status signal: ' + result.error);
                queueRender();
            } else if (typeof result.available === 'boolean') {
                onAvailability(result.available);
                onClimate2SetpointAvailability(result.available);
            }
        }).catch((e) => {
            if (stopped) return;
            live.signalError = true;
            live.signalAvailable = false;
            live.stale = true;
            onClimate2SetpointAvailability(false);
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
                    driverUnitC: true, passengerUnitC: true,
                    driverStatus: 'demo', passengerStatus: 'demo',
                    ac: true,
                };
            }
            return {
                demo: false,
                driver: live.zones.driver.state === 'live' ? live.zones.driver.value : null,
                passenger: live.zones.passenger.state === 'live' ? live.zones.passenger.value : null,
                driverUnitC: live.zones.driver.unitC,
                passengerUnitC: live.zones.passenger.unitC,
                driverStatus: live.zones.driver.state,
                passengerStatus: live.zones.passenger.state,
                ac: live.ac,
            };
        }

        function drawSettingsMark(cv) {
            const cx = 1440, cy = 67;
            for (let i = 0; i < 8; i++) {
                const a = i * Math.PI / 4;
                cv.line(cx + Math.cos(a) * 10, cy + Math.sin(a) * 10,
                    cx + Math.cos(a) * 17, cy + Math.sin(a) * 17, 3, C.white);
            }
            cv.circle(cx, cy, 10, C.white);
            cv.circle(cx, cy, 4, C.bg);
            cv.text('SETTINGS', 1470, 65, 14, C.white, { font: 'bold', spacing: 1.2 });
        }

        function drawFlowLines(cv, left) {
            // Decorative vent / airflow motif inspired by the BMW climate UI.
            // These lines are visual only; they are not clickable climate controls.
            for (let i = 0; i < 7; i++) {
                const y = 216 + i * 24;
                const spread = (i - 3) * 8;
                const color = i === 3 ? C.red : (i % 2 ? C.redDim : C.redFaint);
                const points = left
                    ? [[72, y + spread], [142, y - 13], [220, y + 9], [302, y - 4], [390, y + spread / 2]]
                    : [[1528, y + spread], [1458, y - 13], [1380, y + 9], [1298, y - 4], [1210, y + spread / 2]];
                cv.polyline(points, i === 3 ? 2.6 : 1.4, color);
            }
            // Short illuminated vent slats make the airflow artwork read as one
            // connected climate surface rather than separate data cards.
            for (let i = 0; i < 4; i++) {
                const y = 207 + i * 11;
                if (left) cv.line(170, y, 388, y + 2, 1, C.redDim);
                else cv.line(1212, y + 2, 1430, y, 1, C.redDim);
            }
        }

        function zoneStatus(signalStatus, demo, unitC) {
            if (demo) return { text: 'DEMO · NOT VEHICLE DATA', color: C.red };
            if (signalStatus === 'live') return { text: unitC ? 'LIVE VALUE · IHKA' : 'LIVE VALUE · UNIT UNVERIFIED', color: C.red };
            if (signalStatus === 'stale') return { text: 'SIGNAL STALE', color: C.muted };
            if (signalStatus === 'invalid') return { text: 'INVALID SIGNAL PAYLOAD', color: C.muted };
            if (signalStatus === 'waiting') return { text: 'WAITING FOR VEHICLE DATA', color: C.muted };
            return { text: 'SIGNAL UNAVAILABLE', color: C.muted };
        }

        function climateZone(cv, cx, title, value, demo, signalStatus, unitC) {
            const shown = temperatureDisplay(value, demo || unitC);
            const unitSize = 26, gap = 9;
            const maxWidth = 280;
            let size = shown.size + 12;
            const valueWidthAt = (n) => cv.textWidth(shown.text, n, { font: shown.font }) +
                (shown.unit ? gap + cv.textWidth('°C', unitSize, { font: 'bold' }) : 0);
            while (size > 24 && valueWidthAt(size) > maxWidth) size -= 2;
            const fullWidth = valueWidthAt(size), left = cx - fullWidth / 2;
            const numberWidth = cv.textWidth(shown.text, size, { font: shown.font });

            // Angular red accents frame the real read-only setpoint without
            // suggesting that the user can adjust it from this screen.
            cv.line(cx - 178, 242, cx - 144, 242, 2, C.red);
            cv.line(cx + 144, 242, cx + 178, 242, 2, C.red);
            cv.text(title, cx, 205, 23, C.white,
                { align: 'center', font: 'bold', spacing: 2.8 });
            cv.text('SET TEMPERATURE', cx, 229, 12, C.muted,
                { align: 'center', font: 'bold', spacing: 1.9 });

            cv.text(shown.text, left, 333, size, shown.color, { font: shown.font });
            if (shown.unit) cv.text('°C', left + numberWidth + gap, 321, unitSize, C.muted, { font: 'bold' });

            const status = zoneStatus(demo ? 'demo' : signalStatus, demo, unitC);
            cv.text(status.text, cx, 371, 12, status.color,
                { align: 'center', font: 'bold', spacing: 0.65 });
        }

        function acStatus(s) {
            if (s.demo) return { text: 'DEMO · A/C ON', color: C.red };
            if (live.signalError || !live.signalAvailable || live.stale) return { text: 'A/C STATUS · SIGNAL UNAVAILABLE', color: C.muted };
            if (!live.seenAc) return { text: 'A/C STATUS · WAITING FOR DATA', color: C.muted };
            if (live.invalidAc || s.ac === null) return { text: 'A/C STATUS · SIGNAL UNAVAILABLE', color: C.muted };
            return { text: 'A/C STATUS · ' + (s.ac ? 'ON' : 'OFF'), color: s.ac ? C.red : C.white };
        }

        async function render() {
            if (stopped) return;
            const s = state();
            const cv = ctx.canvas(W, H).clear(C.bg);
            cv.gradientRect(0, 0, W, H, [[0, '#050505'], [0.48, '#100407'], [1, '#050505']]);

            cv.text('CLIMATE CONTROL', 72, 72, 25, C.white, { font: 'bold', spacing: 2.1 });
            cv.fillRect(72, 91, 156, 2, C.red);
            cv.fillRect(228, 92, 1300, 1, C.redDim);
            drawSettingsMark(cv);
            drawFlowLines(cv, true);
            drawFlowLines(cv, false);
            climateZone(cv, 500, 'DRIVER', s.driver, s.demo, s.driverStatus, s.driverUnitC);
            climateZone(cv, 1100, 'PASSENGER', s.passenger, s.demo, s.passengerStatus, s.passengerUnitC);
            cv.fillRect(799, 176, 2, 216, C.redDim);
            cv.circle(800, 284, 4, C.red);

            const status = acStatus(s);
            cv.fillRect(72, 428, 1456, 1, C.redDim);
            cv.roundRect(654, 445, 292, 42, 20, '#12090A');
            cv.strokeRoundRect(654, 445, 292, 42, 20, 1.4, status.color);
            cv.text(status.text, 800, 472, 14, status.color, { align: 'center', font: 'bold', spacing: 1.0 });
            cv.text(s.demo ? 'DEMO PREVIEW · NOT VEHICLE DATA' : 'LIVE VEHICLE DATA · READ ONLY', 1528, 495, 10, C.faint,
                { align: 'right', font: 'bold', spacing: 1.1 });

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

        ctx.onTap((x, y) => {
            if (x < 1390 || x > 1560 || y < 20 || y > 100) return;
            const button = ui.rhmi && ui.rhmi.getByName && ui.rhmi.getByName('BTN_SETTINGS');
            if (button && typeof button.emit === 'function') button.emit('action', {});
        });
        ctx.onLayout(queueRender);
        render().catch((e) => log.warn('first render: ' + (e && e.message || e)));
    },
});
