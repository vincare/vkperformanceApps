'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const fs = require('fs');
const path = require('path');
const { VehicleDataManager, CHANNELS } = require('./vehicle_data');
const { RecordingStore } = require('./recording');

const W = 1600, H = 520, RATE_MS = 250;
const NAV = ['LIVE', 'RECORD', 'PROFILES', 'LOGS', 'ANALYZER', 'COMPARE', 'HEALTH', 'SETTINGS'];
const CATEGORIES = ['ENGINE INFO', 'POWERTRAIN', 'BOOST', 'FUEL SYSTEM', 'IGNITION', 'TEMPERATURES', 'DRIVETRAIN', 'ELECTRICAL', 'TYRES INFO', 'VEHICLE DYNAMICS', 'GPS DATA'];
const PROFILES = [
    { name: 'PERFORMANCE LOG', keys: ['rpm', 'speed', 'torque', 'boostActual', 'boostTarget', 'engineLoad'] },
    { name: 'TUNING LOG', keys: ['rpm', 'speed', 'torque', 'boostActual', 'boostTarget', 'engineLoad', 'iat', 'hpfp', 'lpfp', 'ignitionTiming'] },
    { name: 'BOOST LOG', keys: ['rpm', 'speed', 'boostActual', 'boostTarget', 'iat'] },
    { name: 'FUEL SYSTEM LOG', keys: ['rpm', 'hpfp', 'hpfpTarget', 'lpfp', 'fuelLevel', 'lambda', 'shortFuelTrim', 'longFuelTrim'] },
    { name: 'IGNITION LOG', keys: ['rpm', 'ignitionTiming', 'cylinderTiming', 'knock', 'misfireCounters'] },
    { name: 'TEMPERATURE LOG', keys: ['oilTemp', 'coolantTemp', 'iat', 'gearboxTemp', 'ambientTemp'] },
    { name: 'TRANSMISSION LOG', keys: ['speed', 'gear', 'gearboxTemp', 'gearboxTempEgs', 'torque'] },
    { name: 'DIAGNOSTIC LOG', keys: ['rpm', 'engineStatus', 'engineLoad', 'boostActual', 'hpfp', 'lpfp', 'ignitionTiming', 'oilTemp', 'coolantTemp', 'gearboxTemp', 'gearboxTempEgs', 'batteryVoltage'] },
    { name: 'CUSTOM LOG', keys: [] },
];
const HEALTH_GROUPS = [
    { name: 'ENGINE SYSTEM', keys: ['rpm', 'engineStatus', 'engineLoad', 'misfireCounters'], dtc: true },
    { name: 'TURBO SYSTEM', keys: ['boostActual', 'boostTarget', 'boostDeviation', 'wastegatePosition'], dtc: true },
    { name: 'FUEL SYSTEM', keys: ['hpfp', 'hpfpTarget', 'lpfp', 'lambda', 'shortFuelTrim', 'longFuelTrim'] },
    { name: 'IGNITION SYSTEM', keys: ['ignitionTiming', 'cylinderTiming', 'knock', 'misfireCounters'] },
    { name: 'COOLING SYSTEM', keys: ['oilTemp', 'coolantTemp', 'iat'], dtc: true },
    { name: 'TRANSMISSION', keys: ['gearboxTemp', 'gearboxTempEgs', 'gear'], dtc: true },
    { name: 'ELECTRICAL SYSTEM', keys: ['batteryVoltage', 'batteryCondition', 'batterySoc', 'chargingStatus', 'auxBatteryStatus'] },
    { name: 'TYRE SYSTEM', keys: ['tyrePFL', 'tyrePFR', 'tyrePRL', 'tyrePRR', 'tyrePtFL', 'tyrePtFR', 'tyrePtRL', 'tyrePtRR', 'tyreTFL', 'tyreTFR', 'tyreTRL', 'tyreTRR'] },
];
const finite = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function shortError(e) { return String(e && e.message || e || 'unknown').replace(/[\r\n]+/g, ' '); }
function fmt(v, d) { return finite(v) ? String(Math.round(v * Math.pow(10, d == null ? 1 : d)) / Math.pow(10, d == null ? 1 : d)) : '--'; }
function stamp(t) { try { return new Date(t).toISOString().replace('T', ' ').slice(0, 19); } catch (e) { return '--'; } }
function statusColor(s) { return s === 'LIVE' || s === 'NORMAL' ? '#35c779' : s === 'WARNING' ? '#f2c94c' : s === 'CRITICAL' ? '#ff4757' : s === 'CHECKING' ? '#54aaff' : '#9299a5'; }

function profileKeys(profile) { return profile && Array.isArray(profile.keys) ? profile.keys.slice() : []; }
function vehicleLabel(settings) {
    return settings.get('vehicleProfile') === 'auto'
        ? 'BMW · signals identified by live provider availability (vehicle identity not read)'
        : 'BMW M340i G20 · B58TU (user-selected reference)';
}

mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;
        const appDir = path.join(ctx.dataDir, 'vlogmaster');
        try { fs.mkdirSync(appDir, { recursive: true }); } catch (e) { log.warn('VLogMaster storage: ' + shortError(e)); }
        const prefsFile = path.join(appDir, 'preferences.json');
        let prefs = {};
        try { prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch (e) { /* first start */ }
        const data = new VehicleDataManager(ctx);
        const store = new RecordingStore(ctx.dataDir, log);
        let page = 0, category = 'ENGINE INFO', profileIndex = 0, pageOffset = 0;
        let selected = Array.isArray(prefs.selected) ? prefs.selected.filter((k) => data.metricDefs[k]) : ['rpm', 'speed', 'torque', 'oilTemp', 'coolantTemp'];
        let liveDemand = new Set(Array.isArray(prefs.liveDemand) ? prefs.liveDemand : []);
        let focusedKey = 'rpm', selectedLogId = null, analyzerKey = 'rpm', compareKey = null, compareIds = [], visibleAnalyzerKeys = [];
        let analyzerZoom = 1, analyzerRight = 1;
        let stopped = false, dirty = true, renderBusy = false, renderTimer = null, lastRender = 0;
        let targets = [], renameMode = false, renameText = '', deleteArmUntil = 0;
        let healthRunning = false, healthTimer = null, healthHistory = [], healthHistoryView = false, healthSelected = null;
        const healthFile = path.join(appDir, 'health.json');
        try { const h = JSON.parse(fs.readFileSync(healthFile, 'utf8')); if (Array.isArray(h)) healthHistory = h.slice(0, 20); } catch (e) { /* first start */ }
        const theme = () => ctx.theme();
        const recording = () => store.active;
        const isRecording = () => !!(store.active && store.active.log.status === 'RECORDING');
        function savePrefs() {
            try { const tmp = prefsFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ selected, liveDemand: Array.from(liveDemand) })); fs.renameSync(tmp, prefsFile); }
            catch (e) { log.warn('VLogMaster preferences: ' + shortError(e)); }
        }
        function diagDemand() {
            const keys = new Set(page === 0 ? liveDemand : []);
            if (recording()) selected.forEach((k) => keys.add(k));
            if (healthRunning) CHANNELS.filter((c) => c.diagnostic).forEach((c) => keys.add(c.key));
            data.setDemand(Array.from(keys));
        }
        function queueRender() {
            if (stopped) return;
            dirty = true;
            if (renderTimer || renderBusy) return;
            renderTimer = setTimeout(() => { renderTimer = null; render().catch((e) => log.warn('VLogMaster render: ' + shortError(e))); }, RATE_MS);
        }
        function hit(x, y, w, h, action) { targets.push({ x, y, w, h, action }); }
        function addButton(cv, t, x, y, w, h, label, action, primary) {
            const color = primary ? '#d51c32' : '#303640';
            cv.roundRect(x, y, w, h, 9, color);
            if (!primary) cv.strokeRoundRect(x, y, w, h, 9, 1, '#59616c');
            cv.text(label, x + w / 2, y + h * 0.63, 17, '#ffffff', { align: 'center', font: 'bold', spacing: 0.8 });
            hit(x, y, w, h, action);
        }
        function header(cv, t, title, sub) {
            cv.text(title, 300, 77, 25, '#f4f6f9', { font: 'bold', spacing: 2 });
            cv.text(sub || '', 301, 101, 14, '#9299a5', { spacing: 0.3 });
            cv.fillRect(300, 112, 1240, 2, '#3a414b');
            cv.fillRect(300, 112, 126, 2, '#d51c32');
            G.stripes(cv, t, 1470, 68, 62);
        }
        function card(cv, x, y, w, h, title, status) {
            cv.roundRect(x, y, w, h, 10, '#1a1e24');
            cv.strokeRoundRect(x, y, w, h, 10, 1, '#343b45');
            if (title) cv.text(String(title).toUpperCase(), x + 16, y + 25, 15, '#a9b0bb', { font: 'bold', spacing: 1.1 });
            if (status) {
                const c = statusColor(status);
                cv.roundRect(x + w - 112, y + 11, 96, 22, 10, c + '30');
                cv.text(status, x + w - 64, y + 27, 12, c, { align: 'center', font: 'bold', spacing: 0.6 });
            }
        }
        function displayValue(metric, channel) {
            if (!metric || metric.value == null || metric.status !== 'LIVE') return '--';
            if (typeof metric.value === 'string') return metric.value;
            return fmt(metric.value, channel && channel.key === 'rpm' ? 0 : 1);
        }
        function channelCard(cv, t, c, x, y, w, h, mode) {
            const m = data.get(c.key), selectedNow = mode === 'select' && selected.indexOf(c.key) >= 0;
            const border = mode === 'select' && selectedNow ? '#d51c32' : '#343b45';
            cv.roundRect(x, y, w, h, 9, '#1a1e24');
            cv.strokeRoundRect(x, y, w, h, 9, selectedNow ? 2 : 1, border);
            const labelColor = c.unsupported ? '#7e8793' : '#b7bec9';
            cv.text(c.label, x + 14, y + 24, 13, labelColor, { font: 'bold', spacing: 0.7 });
            const value = displayValue(m, c);
            cv.text(value, x + 14, y + 62, 31, m.status === 'LIVE' ? '#f4f6f9' : '#727b88', { font: 'num' });
            const valueWidth = cv.textWidth(value, 31, { font: 'num' });
            cv.text(c.unit || '', x + 23 + valueWidth, y + 60, 14, '#9299a5');
            const st = c.unsupported ? 'UNAVAILABLE' : m.status;
            cv.fillRect(x + 14, y + h - 21, 5, 5, statusColor(st));
            cv.text(st + (m.at ? ' · ' + fmt((Date.now() - m.at) / 1000, 0) + 's' : ''), x + 26, y + h - 13, 11, statusColor(st), { font: 'bold', spacing: 0.5 });
            if (mode === 'select') cv.text(selectedNow ? 'SELECTED' : 'TAP TO ADD', x + w - 14, y + h - 13, 10, selectedNow ? '#f07c88' : '#737c88', { align: 'right', font: 'bold', spacing: 0.6 });
            hit(x, y, w, h, () => {
                focusedKey = c.key;
                if (mode === 'select') {
                    if (recording()) return;
                    selectedNow ? selected.splice(selected.indexOf(c.key), 1) : selected.push(c.key);
                    if (page === 2) profileIndex = PROFILES.length - 1;
                    selected = Array.from(new Set(selected));
                    savePrefs(); diagDemand();
                } else if (c.diagnostic) {
                    if (liveDemand.has(c.key)) liveDemand.delete(c.key); else liveDemand.add(c.key);
                    savePrefs(); diagDemand();
                }
                queueRender();
            });
        }
        function drawPageNav(cv) {
            const t = theme();
            cv.roundRect(24, 52, 244, 444, 13, '#171a20');
            cv.strokeRoundRect(24, 52, 244, 444, 13, 1, '#323943');
            cv.text('VLOG', 44, 91, 29, '#f4f6f9', { font: 'bold', spacing: 2 });
            cv.text('MASTER', 44 + cv.textWidth('VLOG', 29, { font: 'bold', spacing: 2 }) + 8, 91, 29, '#d51c32', { font: 'bold', spacing: 1.1 });
            cv.text('BMW DATA · READ ONLY', 45, 116, 11, '#7e8793', { font: 'bold', spacing: 0.7 });
            cv.fillRect(42, 130, 208, 1, '#3b424d');
            NAV.forEach((item, i) => {
                const y = 143 + i * 42, active = page === i;
                if (active) cv.roundRect(36, y, 220, 36, 8, '#641722');
                cv.fillRect(47, y + 8, 3, 20, active ? '#ff4055' : '#454c56');
                cv.text(item, 62, y + 24, 15, active ? '#ffffff' : '#a7aeb8', { font: active ? 'bold' : 'label', spacing: 0.7 });
                hit(36, y, 220, 36, () => setPage(i));
            });
            cv.fillRect(42, 484, 208, 1, '#3b424d');
            cv.circle(51, 511, 5, isRecording() ? '#ff4458' : '#35c779');
            cv.text(isRecording() ? 'RECORDING' : 'SIGNALS · ' + (Object.keys(data.providers).filter((k) => data.providers[k]).length || 0) + ' ONLINE', 64, 516, 11, isRecording() ? '#ff6677' : '#9299a5', { font: 'bold', spacing: 0.5 });
        }
        function drawLive(cv, t) {
            header(cv, t, 'LIVE DATA', category + ' · confirmed MGU / read-only DME channels');
            const categorySet = new Set(CATEGORIES);
            const chips = CATEGORIES.filter((v) => categorySet.has(v));
            const chipW = 145, chipH = 26, gap = 8, cols = 7;
            chips.forEach((name, i) => {
                const row = Math.floor(i / cols), col = i % cols, x = 300 + col * (chipW + gap), y = 124 + row * 34;
                const on = category === name;
                cv.roundRect(x, y, chipW, chipH, 6, on ? '#8d1725' : '#242a32');
                cv.text(name, x + chipW / 2, y + 18, 10, on ? '#fff' : '#aeb6c1', { align: 'center', font: 'bold', spacing: 0.25 });
                hit(x, y, chipW, chipH, () => { category = name; pageOffset = 0; queueRender(); });
            });
            const list = CHANNELS.filter((c) => c.category === category);
            const rows = list.slice(pageOffset, pageOffset + 6), cw = 396, ch = 100, gx = 16, gy = 14, sx = 300, sy = 207;
            if (!rows.length) cv.text('NO MAPPED CHANNELS', sx + 30, sy + 40, 19, '#9299a5', { font: 'bold' });
            rows.forEach((c, i) => {
                const x = sx + (i % 3) * (cw + gx), y = sy + Math.floor(i / 3) * (ch + gy);
                channelCard(cv, t, c, x, y, cw, ch, 'live');
                if (c.diagnostic) {
                    const m = data.get(c.key), active = liveDemand.has(c.key);
                    cv.text(active ? 'POLLING ENABLED' : 'TAP TO READ', x + cw - 14, y + ch - 13, 10, active ? '#65b4ff' : '#7d8794', { align: 'right', font: 'bold' });
                }
            });
            if (list.length > 6) {
                const max = Math.max(0, list.length - 6);
                addButton(cv, t, 1405, 454, 62, 31, '‹', () => { pageOffset = Math.max(0, pageOffset - 1); queueRender(); }, false);
                addButton(cv, t, 1476, 454, 62, 31, '›', () => { pageOffset = Math.min(max, pageOffset + 1); queueRender(); }, false);
            }
            cv.text('Touch a diagnostic card to opt it into paced, read-only ECU polling.', 300, 493, 12, '#77818e');
        }
        function drawRecording(cv, t) {
            header(cv, t, 'DATA RECORDING', 'Choose channels · recording samples valid incoming data independently of graph redraw');
            const active = recording(), status = active ? active.log.status : 'READY';
            card(cv, 300, 126, 1228, 72, 'SESSION', active ? status : 'READY');
            if (active) {
                const secs = Math.max(0, (Date.now() - active.log.startedAt) / 1000);
                const activeSecs = Math.max(0, store.activeDurationMs() / 1000);
                cv.text(fmt(secs, 0) + ' s', 328, 170, 24, '#fff', { font: 'num' });
                cv.text('DURATION', 425, 163, 11, '#8d97a4', { font: 'bold' });
                cv.text(String(active.log.sampleCount), 566, 170, 24, '#fff', { font: 'num' });
                cv.text('SAMPLES', 662, 163, 11, '#8d97a4', { font: 'bold' });
                cv.text(fmt(activeSecs > 0 ? active.log.sampleCount / activeSecs : 0, 2) + ' Hz', 800, 170, 24, '#fff', { font: 'num' });
                cv.text('AGGREGATE', 926, 163, 11, '#8d97a4', { font: 'bold' });
                const def = data.metricDefs[focusedKey] || CHANNELS[0], stat = active.log.stats[focusedKey];
                cv.text(def.label + ' · MIN ' + fmt(stat && stat.min, 1) + '  AVG ' + fmt(stat && stat.n ? stat.sum / stat.n : null, 1) + '  MAX ' + fmt(stat && stat.max, 1) + ' ' + (def.unit || ''), 328, 187, 11, '#9da6b2', { font: 'bold' });
                const trace = data.recent(focusedKey, 54).filter((p) => finite(p.v));
                cv.roundRect(1040, 135, 228, 52, 6, '#11151b');
                cv.text('LIVE TRACE', 1050, 149, 9, '#7f8995', { font: 'bold', spacing: 0.8 });
                if (trace.length > 1) {
                    const vals = trace.map((p) => p.v), low = Math.min.apply(null, vals), high = Math.max.apply(null, vals), span = high - low || 1;
                    cv.polyline(trace.map((p, i) => [1051 + i * 4, 179 - (p.v - low) / span * 24]), 1.8, '#55baff');
                } else cv.text('WAITING FOR SIGNAL', 1050, 174, 10, '#727b88');
                addButton(cv, t, 1290, 141, 102, 38, active.log.status === 'PAUSED' ? 'RESUME' : 'PAUSE', () => pauseRecording(), false);
                addButton(cv, t, 1405, 141, 101, 38, 'STOP', () => stopRecording(), true);
            } else {
                cv.text('Select signals below, then start recording.', 328, 168, 18, '#c8cdd5');
                cv.text('Profiles stay editable on the next page.', 940, 168, 14, '#7f8995');
                addButton(cv, t, 1360, 140, 145, 40, 'START RECORDING', () => startRecording(), true);
            }
            cv.text('SELECT SIGNALS', 302, 218, 14, '#c2c9d2', { font: 'bold', spacing: 1.2 });
            const start = pageOffset * 12, list = CHANNELS.slice(start, start + 12), cols = 4, cw = 294, ch = 64, gap = 16;
            list.forEach((c, i) => channelCard(cv, t, c, 300 + (i % cols) * (cw + gap), 230 + Math.floor(i / cols) * 72, cw, ch, 'select'));
            const maxPage = Math.max(0, Math.ceil(CHANNELS.length / 12) - 1);
            addButton(cv, t, 1342, 464, 83, 30, 'PREV', () => { pageOffset = Math.max(0, pageOffset - 1); queueRender(); }, false);
            addButton(cv, t, 1430, 464, 98, 30, 'NEXT', () => { pageOffset = Math.min(maxPage, pageOffset + 1); queueRender(); }, false);
            if (active) cv.text('Channel selection is locked while a log is being captured.', 300, 496, 11, '#7f8995');
        }
        function drawProfiles(cv, t) {
            header(cv, t, 'RECORDING PROFILES', 'Select a preset, then add or remove any signal before recording');
            const leftX = 300, leftW = 300;
            PROFILES.forEach((p, i) => {
                const y = 130 + i * 39, on = i === profileIndex;
                cv.roundRect(leftX, y, leftW, 32, 7, on ? '#791523' : '#1d2229');
                cv.text(p.name, leftX + 14, y + 22, 13, on ? '#fff' : '#aab1bb', { font: 'bold', spacing: 0.6 });
                hit(leftX, y, leftW, 32, () => { profileIndex = i; if (p.name !== 'CUSTOM LOG') { selected = profileKeys(p); savePrefs(); diagDemand(); } queueRender(); });
            });
            cv.text('PROFILE CHANNELS', 630, 141, 14, '#c2c9d2', { font: 'bold', spacing: 1.2 });
            cv.text('TAP TO EDIT', 1518, 141, 11, '#7e8793', { align: 'right', font: 'bold' });
            const list = CHANNELS.slice(pageOffset * 8, pageOffset * 8 + 8);
            list.forEach((c, i) => channelCard(cv, t, c, 630 + (i % 2) * 444, 158 + Math.floor(i / 2) * 64, 428, 56, 'select'));
            const p = PROFILES[profileIndex];
            cv.text((p.name === 'CUSTOM LOG' ? 'CUSTOM' : p.name) + ' · ' + selected.length + ' selected', 630, 484, 13, '#9299a5', { font: 'bold' });
            addButton(cv, t, 1330, 459, 194, 40, 'APPLY PROFILE', () => { selected = profileKeys(PROFILES[profileIndex]); savePrefs(); diagDemand(); queueRender(); }, true);
            addButton(cv, t, 630, 459, 114, 40, 'CHANNELS ‹', () => { pageOffset = Math.max(0, pageOffset - 1); queueRender(); }, false);
            addButton(cv, t, 752, 459, 114, 40, 'CHANNELS ›', () => { pageOffset = Math.min(Math.ceil(CHANNELS.length / 8) - 1, pageOffset + 1); queueRender(); }, false);
        }
        function drawHistory(cv, t) {
            header(cv, t, 'LOG HISTORY', 'Local recordings · select a log for analysis, rename, delete or export');
            const logs = store.list().slice(pageOffset, pageOffset + 6);
            logs.forEach((l, i) => {
                const y = 129 + i * 54, on = selectedLogId === l.id;
                cv.roundRect(300, y, 1224, 46, 8, on ? '#3e1720' : '#1b2027');
                cv.strokeRoundRect(300, y, 1224, 46, 8, on ? 2 : 1, on ? '#d51c32' : '#343b45');
                cv.text(l.name, 316, y + 21, 15, '#f1f3f6', { font: 'bold' });
                cv.text(stamp(l.startedAt) + ' · ' + fmt((l.durationMs || 0) / 1000, 0) + ' s · ' + l.sampleCount + ' samples', 316, y + 38, 11, '#8993a0');
                cv.text(l.channels.length + ' channels', 1195, y + 29, 12, '#b5bdc7', { align: 'right' });
                cv.text(l.status || 'SAVED', 1500, y + 29, 11, l.status === 'INTERRUPTED' ? '#f2c94c' : '#35c779', { align: 'right', font: 'bold' });
                hit(300, y, 1224, 46, () => { selectedLogId = l.id; analyzerKey = l.channels[0] || 'rpm'; visibleAnalyzerKeys = [analyzerKey]; analyzerZoom = 1; analyzerRight = 1; queueRender(); });
            });
            if (!logs.length) cv.text('NO RECORDINGS YET · create one on DATA RECORDING', 320, 170, 18, '#87909c', { font: 'bold' });
            const chosen = store.get(selectedLogId);
            addButton(cv, t, 300, 464, 150, 36, renameMode ? 'CANCEL RENAME' : 'RENAME', () => { if (!chosen) return; renameMode ? (renameMode = false) : (renameMode = true, renameText = chosen.name); queueRender(); }, false);
            addButton(cv, t, 460, 464, 150, 36, Date.now() < deleteArmUntil ? 'CONFIRM DELETE' : 'DELETE LOG', () => deleteSelected(), false);
            addButton(cv, t, 620, 464, 150, 36, 'EXPORT CSV', () => exportLog('csv'), false);
            addButton(cv, t, 780, 464, 150, 36, 'EXPORT JSON', () => exportLog('json'), false);
            addButton(cv, t, 940, 464, 142, 36, 'COMPARE', () => { if (chosen) { selectCompareLog(chosen.id); setPage(5); } }, false);
            addButton(cv, t, 1370, 464, 154, 36, 'ANALYZE SELECTED', () => { if (chosen) setPage(4); }, true);
            if (store.list().length > 6) {
                addButton(cv, t, 1200, 464, 76, 36, '‹', () => { pageOffset = Math.max(0, pageOffset - 1); queueRender(); }, false);
                addButton(cv, t, 1283, 464, 76, 36, '›', () => { pageOffset = Math.min(Math.ceil(store.list().length / 6) - 1, pageOffset + 1); queueRender(); }, false);
            }
            if (renameMode) drawKeyboard(cv, t);
        }
        function drawKeyboard(cv, t) {
            cv.roundRect(416, 194, 1000, 230, 12, '#11151b');
            cv.strokeRoundRect(416, 194, 1000, 230, 12, 2, '#d51c32');
            cv.text('RENAME RECORDING', 440, 221, 14, '#e5e8ed', { font: 'bold', spacing: 1.1 });
            cv.text(renameText || 'TYPE A NAME', 1388, 221, 15, '#fff', { align: 'right' });
            const rows = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
            rows.forEach((r, ri) => {
                const keyW = 58, gap = 8, rowW = r.length * (keyW + gap) - gap, x0 = 916 - rowW / 2, y = 238 + ri * 48;
                r.split('').forEach((ch, i) => {
                    const x = x0 + i * (keyW + gap);
                    cv.roundRect(x, y, keyW, 39, 5, '#2a3039'); cv.text(ch, x + keyW / 2, y + 26, 17, '#fff', { align: 'center', font: 'bold' });
                    hit(x, y, keyW, 39, () => { renameText = (renameText + ch).slice(0, 40); queueRender(); });
                });
            });
            addButton(cv, t, 662, 385, 152, 30, 'SPACE', () => { renameText = (renameText + ' ').slice(0, 40); queueRender(); }, false);
            addButton(cv, t, 824, 385, 130, 30, 'DELETE CHAR', () => { renameText = renameText.slice(0, -1); queueRender(); }, false);
            addButton(cv, t, 966, 385, 130, 30, 'SAVE NAME', () => { store.rename(selectedLogId, renameText); renameMode = false; queueRender(); }, true);
            addButton(cv, t, 1108, 385, 130, 30, 'CANCEL', () => { renameMode = false; queueRender(); }, false);
        }
        function drawAnalyzer(cv, t) {
            const logItem = store.get(selectedLogId) || store.list()[0];
            if (logItem && !selectedLogId) selectedLogId = logItem.id;
            header(cv, t, 'LOG ANALYZER', logItem ? logItem.name + ' · ' + logItem.channels.length + ' channels · ' + logItem.status : 'Select a log from LOG HISTORY');
            if (!logItem) { cv.text('NO LOG TO ANALYZE', 330, 180, 20, '#9299a5', { font: 'bold' }); return; }
            const samples = store.samples(logItem.id), keys = logItem.channels.filter((k) => samples.some((s) => s.key === k));
            if (keys.indexOf(analyzerKey) < 0) analyzerKey = keys[0] || logItem.channels[0];
            const channel = data.metricDefs[analyzerKey] || CHANNELS.find((c) => c.key === analyzerKey) || { label: analyzerKey, unit: '' };
            const sameUnitKeys = keys.filter((key) => {
                const def = data.metricDefs[key];
                return def && (def.unit || '') === (channel.unit || '') && samples.some((s) => s.key === key && finite(s.value));
            }).slice(0, 8);
            if (!sameUnitKeys.length && samples.some((s) => s.key === analyzerKey && finite(s.value))) sameUnitKeys.push(analyzerKey);
            if (!visibleAnalyzerKeys.length || visibleAnalyzerKeys.indexOf(analyzerKey) < 0) visibleAnalyzerKeys = [analyzerKey];
            visibleAnalyzerKeys = visibleAnalyzerKeys.filter((key) => sameUnitKeys.indexOf(key) >= 0);
            if (!visibleAnalyzerKeys.length && sameUnitKeys.length) { analyzerKey = sameUnitKeys[0]; visibleAnalyzerKeys = [analyzerKey]; }
            const pointsByKey = Object.create(null);
            visibleAnalyzerKeys.forEach((key) => { pointsByKey[key] = samples.filter((s) => s.key === key && finite(s.value)).slice(-1000); });
            const allPoints = pointsByKey[analyzerKey] || [];
            const dataStart = allPoints.length ? allPoints[0].t : logItem.startedAt;
            const dataEnd = allPoints.length ? allPoints[allPoints.length - 1].t : dataStart + 1000;
            const fullSpan = Math.max(1000, dataEnd - dataStart), windowSpan = Math.max(1000, fullSpan * analyzerZoom);
            const end = dataStart + fullSpan * analyzerRight, start = Math.max(dataStart, end - windowSpan);
            const points = allPoints.filter((p) => p.t >= start && p.t <= end);
            const visiblePoints = visibleAnalyzerKeys.reduce((out, key) => out.concat((pointsByKey[key] || []).filter((p) => p.t >= start && p.t <= end)), []);
            let lo = visiblePoints.length ? Math.min.apply(null, visiblePoints.map((p) => p.value)) : 0, hi = visiblePoints.length ? Math.max.apply(null, visiblePoints.map((p) => p.value)) : 1;
            if (hi - lo < 1e-6) { lo -= 1; hi += 1; } else { const pad = (hi - lo) * 0.12; lo -= pad; hi += pad; }
            const channelStats = logItem.stats[analyzerKey] || {};
            sameUnitKeys.forEach((key, i) => {
                const x = 304 + i * 151, def = data.metricDefs[key], visible = visibleAnalyzerKeys.indexOf(key) >= 0;
                cv.roundRect(x, 124, 143, 24, 6, visible ? '#26384b' : '#1a1e24');
                cv.strokeRoundRect(x, 124, 143, 24, 6, 1, visible ? '#55baff' : '#414954');
                cv.text((visible ? '● ' : '○ ') + def.label, x + 8, 141, 10, visible ? '#dff2ff' : '#8993a0', { font: 'bold' });
                hit(x, 124, 143, 24, () => {
                    if (visibleAnalyzerKeys.indexOf(key) >= 0) {
                        if (visibleAnalyzerKeys.length > 1) visibleAnalyzerKeys = visibleAnalyzerKeys.filter((k) => k !== key);
                    } else visibleAnalyzerKeys.push(key);
                    analyzerKey = key; queueRender();
                });
            });
            cv.text(channel.label, 304, 169, 19, '#e9edf2', { font: 'bold', spacing: 1 });
            cv.text(points.length + ' samples · ' + fmt(logItem.channelHz && logItem.channelHz[analyzerKey], 2) + ' Hz', 1518, 169, 12, '#8d97a4', { align: 'right' });
            const lineColors = ['#55baff', '#ff596e', '#49d39a', '#edc44b', '#b792ff', '#5ed3d9', '#f08cb8', '#d7dce3'];
            const series = visibleAnalyzerKeys.map((key, i) => ({ pts: (pointsByKey[key] || []).filter((p) => p.t >= start && p.t <= end).map((p) => [(p.t - start) / 1000, p.value]), color: lineColors[i % lineColors.length], width: key === analyzerKey ? 2.5 : 1.7, fill: key === analyzerKey ? 0.10 : 0 }));
            G.chart(cv, t, 304, 178, 1210, 222, { xMin: 0, xMax: Math.max(1, (end - start) / 1000), yMin: lo, yMax: hi,
                xStep: Math.max(1, (end - start) / 4000), yStep: Math.max((hi - lo) / 4, 0.1), xUnit: 's', yUnit: channel.unit,
                series, empty: 'NO VALID SAMPLES FOR THIS CHANNEL' });
            const cards = [['MINIMUM', channelStats.min], ['MAXIMUM', channelStats.max], ['AVERAGE', channelStats.avg], ['SAMPLE COUNT', points.length]];
            cards.forEach((c, i) => { const x = 304 + i * 302; card(cv, x, 410, 286, 62, c[0]); cv.text(i === 3 ? String(c[1]) : fmt(c[1], 2) + ' ' + channel.unit, x + 15, 456, 22, '#f2f4f7', { font: 'num' }); });
            addButton(cv, t, 800, 477, 120, 29, 'TIME ‹', () => { analyzerRight = Math.max(analyzerZoom, analyzerRight - analyzerZoom * 0.8); queueRender(); }, false);
            addButton(cv, t, 928, 477, 120, 29, 'ZOOM −', () => { analyzerZoom = Math.min(1, analyzerZoom * 2); analyzerRight = Math.max(analyzerZoom, analyzerRight); queueRender(); }, false);
            addButton(cv, t, 1056, 477, 120, 29, 'ZOOM +', () => { analyzerZoom = Math.max(0.025, analyzerZoom / 2); queueRender(); }, false);
            addButton(cv, t, 1184, 477, 120, 29, 'TIME ›', () => { analyzerRight = Math.min(1, analyzerRight + analyzerZoom * 0.8); queueRender(); }, false);
            addButton(cv, t, 1312, 477, 100, 29, 'CH ‹', () => changeAnalyzerChannel(-1, logItem), false);
            addButton(cv, t, 1420, 477, 100, 29, 'CH ›', () => changeAnalyzerChannel(1, logItem), false);
        }
        function changeAnalyzerChannel(dir, logItem) {
            const keys = logItem.channels;
            const i = Math.max(0, keys.indexOf(analyzerKey)); analyzerKey = keys[(i + dir + keys.length) % keys.length] || analyzerKey;
            visibleAnalyzerKeys = [analyzerKey]; queueRender();
        }
        function drawCompare(cv, t) {
            const logs = store.list();
            if (compareIds.length < 2 && logs.length >= 2) compareIds = [logs[1].id, logs[0].id];
            const first = store.get(compareIds[0]), second = store.get(compareIds[1]);
            header(cv, t, 'COMPARE LOGS', 'Overlay the same numeric channel · values and rates come from each recording');
            if (!first || !second) { cv.text('CREATE TWO RECORDINGS TO COMPARE', 330, 174, 20, '#9299a5', { font: 'bold' }); return; }
            card(cv, 300, 127, 590, 53, first.name); card(cv, 908, 127, 616, 53, second.name);
            const firstSamples = store.samples(first.id), secondSamples = store.samples(second.id);
            const common = first.channels.filter((k) => second.channels.indexOf(k) >= 0 &&
                firstSamples.some((s) => s.key === k && finite(s.value)) && secondSamples.some((s) => s.key === k && finite(s.value))).slice(0, 8);
            if (!common.length) {
                cv.text('NO SHARED NUMERIC CHANNELS IN THESE LOGS', 320, 229, 17, '#9299a5', { font: 'bold' });
            } else {
                if (common.indexOf(compareKey) < 0) compareKey = common[0];
                common.forEach((key, i) => {
                    const x = 300 + i * 153, c = data.metricDefs[key], on = compareKey === key;
                    cv.roundRect(x, 188, 145, 24, 6, on ? '#26384b' : '#1a1e24');
                    cv.strokeRoundRect(x, 188, 145, 24, 6, 1, on ? '#55baff' : '#414954');
                    cv.text(c.label, x + 8, 205, 10, on ? '#dff2ff' : '#8993a0', { font: 'bold' });
                    hit(x, 188, 145, 24, () => { compareKey = key; queueRender(); });
                });
                const aPoints = firstSamples.filter((s) => s.key === compareKey && finite(s.value)).slice(-1000);
                const bPoints = secondSamples.filter((s) => s.key === compareKey && finite(s.value)).slice(-1000);
                const aStart = aPoints.length ? aPoints[0].t : 0, bStart = bPoints.length ? bPoints[0].t : 0;
                const aEnd = aPoints.length ? aPoints[aPoints.length - 1].t : aStart + 1000, bEnd = bPoints.length ? bPoints[bPoints.length - 1].t : bStart + 1000;
                const xMax = Math.max(1, (aEnd - aStart) / 1000, (bEnd - bStart) / 1000);
                const values = aPoints.concat(bPoints).map((p) => p.value);
                let lo = Math.min.apply(null, values), hi = Math.max.apply(null, values);
                if (hi - lo < 1e-6) { lo -= 1; hi += 1; } else { const pad = (hi - lo) * 0.12; lo -= pad; hi += pad; }
                const c = data.metricDefs[compareKey], sa = first.stats[compareKey] || {}, sb = second.stats[compareKey] || {};
                G.chart(cv, t, 300, 215, 1224, 207, { xMin: 0, xMax, yMin: lo, yMax: hi, xStep: Math.max(1, xMax / 5), yStep: Math.max((hi - lo) / 4, 0.1), xUnit: 's', yUnit: c.unit,
                    series: [
                        { pts: aPoints.map((p) => [(p.t - aStart) / 1000, p.value]), color: '#55baff', width: 2.2, fill: 0.08 },
                        { pts: bPoints.map((p) => [(p.t - bStart) / 1000, p.value]), color: '#ff596e', width: 2.2, fill: 0 },
                    ], empty: 'NO VALID SAMPLES FOR THIS CHANNEL' });
                card(cv, 300, 428, 590, 57, first.name);
                card(cv, 908, 428, 616, 57, second.name);
                cv.text('MIN ' + fmt(sa.min, 2) + ' · AVG ' + fmt(sa.avg, 2) + ' · MAX ' + fmt(sa.max, 2) + ' ' + c.unit + ' · ' + fmt(first.channelHz && first.channelHz[compareKey], 2) + ' Hz', 316, 475, 12, '#e1e6ed');
                cv.text('MIN ' + fmt(sb.min, 2) + ' · AVG ' + fmt(sb.avg, 2) + ' · MAX ' + fmt(sb.max, 2) + ' ' + c.unit + ' · ' + fmt(second.channelHz && second.channelHz[compareKey], 2) + ' Hz', 924, 475, 12, '#e1e6ed');
            }
            hit(300, 126, 590, 55, () => { selectedLogId = first.id; setPage(3); });
            hit(908, 126, 616, 55, () => { selectedLogId = second.id; setPage(3); });
        }
        function healthState(group) {
            if (healthRunning) return 'CHECKING';
            const vals = group.keys.map((k) => data.get(k));
            const available = vals.filter((m) => m.status === 'LIVE' && m.value != null).length;
            if (!available) return 'UNAVAILABLE';
            // Measurements may be available, but no validated M340i-specific limits are wired yet.
            // Keep the health verdict unavailable instead of implying a fault from missing thresholds.
            return 'UNAVAILABLE';
        }
        function drawHealth(cv, t) {
            const detail = selectedHealthGroup;
            if (healthHistoryView) {
                header(cv, t, 'HEALTH CHECK HISTORY', 'Saved read-only coverage snapshots · select an entry to inspect returned values');
                if (healthSelected) {
                    const item = healthHistory.find((h) => h.at === healthSelected);
                    cv.text(item ? stamp(item.at) : 'REPORT', 304, 146, 17, '#edf0f4', { font: 'bold' });
                    const rows = item && Array.isArray(item.readings) ? item.readings.slice(0, 16) : [];
                    rows.forEach((r, i) => {
                        const x = 304 + (i % 4) * 304, y = 165 + Math.floor(i / 4) * 68, c = data.metricDefs[r.key] || { label: r.key, unit: '' };
                        card(cv, x, y, 288, 58, c.label, r.status);
                        cv.text(r.value == null ? '--' : String(r.value) + (r.unit ? ' ' + r.unit : ''), x + 14, y + 49, 13, r.status === 'LIVE' ? '#f1f3f6' : '#7d8793');
                    });
                    cv.text(item && item.note || '', 304, 457, 11, '#d9b646');
                    addButton(cv, t, 304, 465, 148, 34, '‹ HISTORY LIST', () => { healthSelected = null; queueRender(); }, false);
                } else {
                    healthHistory.slice(0, 6).forEach((item, i) => {
                        const y = 135 + i * 49;
                        cv.roundRect(304, y, 1210, 42, 7, '#1a1e24');
                        cv.text(stamp(item.at), 320, y + 27, 14, '#edf0f4', { font: 'bold' });
                        const valid = (item.readings || []).filter((r) => r.status === 'LIVE' && r.value != null).length;
                        cv.text(valid + ' valid values captured · coverage snapshot', 900, y + 27, 12, '#a5aeb9');
                        hit(304, y, 1210, 42, () => { healthSelected = item.at; queueRender(); });
                    });
                    if (!healthHistory.length) cv.text('NO HEALTH SNAPSHOTS YET', 322, 177, 17, '#9299a5', { font: 'bold' });
                    addButton(cv, t, 304, 464, 147, 36, '‹ OVERVIEW', () => { healthHistoryView = false; queueRender(); }, false);
                }
                return;
            }
            header(cv, t, 'HEALTH CHECK', 'Read-only coverage snapshot · measured values are not fault verdicts');
            if (detail) {
                const group = HEALTH_GROUPS.find((g) => g.name === detail) || HEALTH_GROUPS[0];
                cv.text(group.name, 303, 146, 18, '#e7ebf1', { font: 'bold', spacing: 1.1 });
                cv.text(healthState(group), 1515, 146, 13, statusColor(healthState(group)), { align: 'right', font: 'bold' });
                const list = group.keys.map((k) => data.metricDefs[k]).filter(Boolean);
                list.slice(0, 8).forEach((c, i) => channelCard(cv, t, c, 304 + (i % 4) * 304, 164 + Math.floor(i / 4) * 96, 288, 84, 'health'));
                if (group.dtc) {
                    card(cv, 304, 371, 1190, 51, 'ENGINE DTC LIST', 'UNAVAILABLE');
                    cv.text('No verified, generic read-only DME/EGS fault-list route is available in this build.', 322, 405, 13, '#a7afb9');
                }
                cv.text('Assessment limits: not yet validated for this engine, tune, temperatures and operating mode.', 304, 450, 12, '#d9b646');
                addButton(cv, t, 304, 466, 122, 34, '‹ OVERVIEW', () => { selectedHealthGroup = null; queueRender(); }, false);
            } else {
                HEALTH_GROUPS.forEach((g, i) => {
                    const x = 300 + (i % 2) * 618, y = 128 + Math.floor(i / 2) * 76, w = 598, h = 64, status = healthState(g);
                    card(cv, x, y, w, h, g.name, status);
                    const good = g.keys.map((k) => data.get(k)).filter((m) => m.status === 'LIVE' && m.value != null).length;
                    cv.text(good + ' live channels · ' + (g.dtc ? 'DTC LIST UNAVAILABLE' : 'limits pending validation'), x + 16, y + 51, 11, '#98a1ad');
                    hit(x, y, w, h, () => { selectedHealthGroup = g.name; queueRender(); });
                });
                const last = healthHistory[0];
                cv.text('LAST CHECK  ' + (last ? stamp(last.at) : '—') + '     HISTORY  ' + healthHistory.length + '     STATUS: NO UNVERIFIED NORMAL VERDICTS', 302, 458, 11, '#9299a5', { font: 'bold' });
                addButton(cv, t, 300, 464, 160, 36, 'CHECK HISTORY', () => { healthHistoryView = true; healthSelected = null; queueRender(); }, false);
                addButton(cv, t, 1166, 464, 164, 36, healthRunning ? 'CHECKING…' : 'START HEALTH CHECK', () => startHealthCheck(), true);
                addButton(cv, t, 1338, 464, 184, 36, 'EXPORT HEALTH REPORT', () => exportHealth(), false);
            }
        }
        let selectedHealthGroup = null;
        function drawSettings(cv, t) {
            header(cv, t, 'SETTINGS', 'VLogMaster app settings and verified capability boundaries');
            const cards = [
                ['VEHICLE PROFILE', settings.get('vehicleProfile') === 'auto' ? 'AUTO · AVAILABLE SIGNALS' : 'BMW M340i G20 · B58TU', 'Tap this row to switch. Auto identifies live signal providers, not a verified chassis/VIN.'],
                ['DATA SOURCES', 'READ ONLY', 'SOME/IP event/get subscriptions · guarded UDS 0x22 and OBD 0x01 / 0x06 only when requested.'],
                ['BACKGROUND RECORDING', 'OFF', 'MGU lifecycle hook exists; unattended logging remains off until verified on this head unit.'],
                ['PHONE TRANSFER', 'LOCAL EXPORT ONLY', 'CSV and JSON files stay in the app data folder; no unsupported network listener or QR file protocol.'],
                ['DTC SCANNING', 'UNAVAILABLE', 'No generic verified read-only DME/EGS DTC list route in this build.'],
            ];
            cards.forEach((c, i) => {
                const y = 133 + i * 68; card(cv, 300, y, 1220, 57, c[0]);
                cv.text(c[1], 318, y + 48, 15, i === 0 ? '#f2f4f7' : '#d9b646', { font: 'bold', spacing: 0.7 });
                cv.text(c[2], 770, y + 45, 12, '#9da6b2');
                if (i === 0) hit(300, y, 1220, 57, () => {
                    settings.set('vehicleProfile', settings.get('vehicleProfile') === 'auto' ? 'm340i-g20-b58tu' : 'auto');
                    queueRender();
                });
            });
            cv.text('NO ECU setters, coding, firmware, resets, clear-fault commands or control routines are included.', 302, 492, 12, '#d5dbe3', { font: 'bold' });
        }

        function drawPage(cv, t) {
            if (page === 0) drawLive(cv, t);
            else if (page === 1) drawRecording(cv, t);
            else if (page === 2) drawProfiles(cv, t);
            else if (page === 3) drawHistory(cv, t);
            else if (page === 4) drawAnalyzer(cv, t);
            else if (page === 5) drawCompare(cv, t);
            else if (page === 6) drawHealth(cv, t);
            else drawSettings(cv, t);
        }
        async function render() {
            if (stopped || renderBusy || !dirty) return;
            renderBusy = true; dirty = false;
            try {
                const cv = ctx.canvas(W, H).clear('#080a0d');
                targets = [];
                cv.gradientRect(0, 0, W, H, [[0, '#080a0d'], [0.48, '#11151b'], [1, '#080a0d']]);
                drawPageNav(cv);
                drawPage(cv, theme());
                const isRec = isRecording();
                G.frame(cv, theme(), NAV, page, [{ text: isRec ? 'REC' : 'READ ONLY', color: isRec ? '#ff485e' : '#4cc38a' }]);
                await ui.image('MAIN_GFX', cv);
            } catch (e) { log.warn('VLogMaster frame: ' + shortError(e)); }
            finally { renderBusy = false; lastRender = Date.now(); if (dirty) queueRender(); }
        }

        function setPage(index) { page = clamp(index, 0, NAV.length - 1); pageOffset = 0; renameMode = false; diagDemand(); queueRender(); }
        function startRecording() {
            if (recording()) return;
            if (!selected.length) { log.warn('VLogMaster: select at least one channel first'); return; }
            const ok = store.start(selected, CHANNELS, vehicleLabel(settings));
            if (!ok) log.warn('VLogMaster: could not open local recording file');
            diagDemand(); queueRender();
        }
        function stopRecording() { if (store.stop('SAVED')) { diagDemand(); queueRender(); } }
        function pauseRecording() {
            const a = recording(); if (!a) return;
            if (a.log.status === 'PAUSED') { store.pause(false); } else store.pause(true);
            queueRender();
        }
        function exportLog(format) {
            const target = store.get(selectedLogId) || store.list()[0];
            if (!target) return;
            selectedLogId = target.id;
            const file = store.export(target.id, format);
            if (file) log.info('VLogMaster exported ' + format.toUpperCase() + ': ' + file);
            queueRender();
        }
        function deleteSelected() {
            const item = store.get(selectedLogId);
            if (!item) return;
            if (Date.now() > deleteArmUntil) { deleteArmUntil = Date.now() + 6000; queueRender(); return; }
            store.remove(item.id); deleteArmUntil = 0; selectedLogId = store.list()[0] ? store.list()[0].id : null; queueRender();
        }
        function startHealthCheck() {
            if (healthRunning) return;
            healthRunning = true;
            diagDemand();
            if (healthTimer) clearTimeout(healthTimer);
            healthTimer = setTimeout(() => {
                healthTimer = null; healthRunning = false;
                const item = { at: Date.now(), vehicle: vehicleLabel(settings), readings: data.snapshot(),
                    note: 'Coverage snapshot only. Vehicle-specific diagnostic thresholds and generic DME/EGS DTC list are not validated.' };
                healthHistory.unshift(item); healthHistory = healthHistory.slice(0, 20);
                try { fs.writeFileSync(healthFile + '.tmp', JSON.stringify(healthHistory)); fs.renameSync(healthFile + '.tmp', healthFile); } catch (e) { log.warn('Health history: ' + shortError(e)); }
                diagDemand(); queueRender();
            }, 25000);
            queueRender();
        }
        function exportHealth() {
            const item = healthHistory[0]; if (!item) return;
            const file = path.join(appDir, 'health-report-' + item.at + '.json');
            try { fs.writeFileSync(file, JSON.stringify(item, null, 2)); log.info('VLogMaster health report: ' + file); } catch (e) { log.warn('Health export: ' + shortError(e)); }
            queueRender();
        }
        function cycleProfile(dir) {
            profileIndex = (profileIndex + dir + PROFILES.length) % PROFILES.length;
            if (PROFILES[profileIndex].name !== 'CUSTOM LOG') selected = profileKeys(PROFILES[profileIndex]);
            else profileIndex = PROFILES.length - 1;
            savePrefs(); diagDemand(); queueRender();
        }
        function selectCompareLog(id) {
            if (compareIds.length < 1) compareIds = [id];
            else if (compareIds.length === 1) {
                if (compareIds[0] !== id) compareIds.push(id);
            } else if (compareIds[1] !== id) compareIds = [compareIds[1], id];
            if (compareIds.length === 1) {
                const other = store.list().find((x) => x.id !== id);
                if (other) compareIds = [other.id, id];
            }
            queueRender();
        }
        function cycleCompare(id) {
            selectCompareLog(id);
        }
        function hitTap(x, y) {
            const item = targets.slice().reverse().find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
            if (item && typeof item.action === 'function') { try { item.action(); } catch (e) { log.warn('VLogMaster action: ' + shortError(e)); } }
        }
        function actionButton() {
            if (page === 1) { if (recording()) stopRecording(); else startRecording(); }
            else if (page === 2) { selected = profileKeys(PROFILES[profileIndex]); savePrefs(); diagDemand(); queueRender(); }
            else if (page === 3) { const item = store.get(selectedLogId); if (item) { if (renameMode) { store.rename(item.id, renameText); renameMode = false; } else { renameMode = true; renameText = item.name; } queueRender(); } }
            else if (page === 4) exportLog('csv');
            else if (page === 6) startHealthCheck();
            else if (page === 0) {
                const c = data.metricDefs[focusedKey]; if (c && c.diagnostic) { liveDemand.has(c.key) ? liveDemand.delete(c.key) : liveDemand.add(c.key); savePrefs(); diagDemand(); }
                queueRender();
            }
        }
        function previousButton() {
            if (page === 1) { if (recording()) pauseRecording(); else { pageOffset = Math.max(0, pageOffset - 1); queueRender(); } }
            else if (page === 2) cycleProfile(-1);
            else if (page === 3) { pageOffset = Math.max(0, pageOffset - 1); queueRender(); }
            else if (page === 4) { const item = store.get(selectedLogId) || store.list()[0]; if (item) changeAnalyzerChannel(-1, item); }
            else if (page === 6 && healthSelected) { healthSelected = null; queueRender(); }
            else if (page === 6 && selectedHealthGroup) { selectedHealthGroup = null; queueRender(); }
        }
        function nextButton() {
            if (page === 1) { pageOffset = Math.min(Math.ceil(CHANNELS.length / 12) - 1, pageOffset + 1); queueRender(); }
            else if (page === 2) { cycleProfile(1); }
            else if (page === 3) { const item = store.get(selectedLogId); if (item) cycleCompare(item.id); else exportLog('json'); }
            else if (page === 4) { const item = store.get(selectedLogId) || store.list()[0]; if (item) changeAnalyzerChannel(1, item); }
            else if (page === 5) { const l = store.list(); if (l.length) cycleCompare(l[0].id); }
            else if (page === 6) exportHealth();
        }

        ui.onClick('BTN_ACTION', actionButton);
        ui.onClick('BTN_PREV', previousButton);
        ui.onClick('BTN_NEXT', nextButton);
        ui.onClick('BTN_SETTINGS', () => setPage(7));
        if (ctx.onTab) ctx.onTab((i) => setPage(i));
        if (ctx.onTap) ctx.onTap((x, y) => hitTap(x, y));
        if (ctx.onLayout) ctx.onLayout(queueRender);
        data.onChange((key, metric) => {
            if (key && metric) store.record(key, metric);
            queueRender();
        });
        data.start();
        diagDemand();
        const onShutdown = () => {
            if (stopped) return;
            stopped = true;
            if (renderTimer) clearTimeout(renderTimer);
            if (healthTimer) clearTimeout(healthTimer);
            if (recording()) store.stop('INTERRUPTED');
            data.shutdown();
            log.info('VLogMaster stopped · subscriptions released · recordings flushed');
        };
        if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('shutdown', onShutdown);
        queueRender();
    },
});
