'use strict';

/** MoreAmbients: BMW's reversible interior-colour selection plus discovered-module RGB control. */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const fs = require('fs');
const path = require('path');

const W = 1600, H = 520;
const LIGHT = 'de.bmw.infotainment.misc.ComfortFunctionIuK';
const BDC = 0x40;
const BUSES = [
    { read: [0xda, 0x5f], write: [0xda, 0x5e] },
    { read: [0xe3, 0xd1], write: [0xe3, 0xd1] },
];
const RECORDS = 26, RECORD_BYTES = 10;
const HOLD_SECONDS = 60, RENEW_MS = 40000;
const FAVOURITES = 6;
const C = {
    bg: '#07090E', panel: '#11151E', panel2: '#171D28', edge: '#293241',
    white: '#F5F7FC', muted: '#A2ADBD', dim: '#677384', faint: '#414C5C',
    cyan: '#54D9FF', blue: '#4B8BFF', violet: '#9C73FF', pink: '#EE5AAE',
    green: '#63D99B', amber: '#F4BE5E', red: '#F35C65',
};
const UPPER_LOC = new Set([0x05, 0x06, 0x09, 0x0a, 0x0c, 0x0d, 0x10, 0x11, 0x13, 0x14, 0x15, 0x16,
    0x17, 0x18, 0x19, 0x1a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x35, 0x36, 0x37,
    0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
    0x47, 0x48, 0x49, 0x4a, 0x62, 0x63, 0x64, 0x65]);
const LOWER_LOC = new Set([0x01, 0x02, 0x03, 0x04, 0x07, 0x08, 0x0b, 0x0e, 0x0f, 0x12, 0x1b, 0x1c,
    0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x33, 0x34, 0x4b, 0x4c]);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isFiniteNumber = (n) => typeof n === 'number' && isFinite(n);

function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 1); v = clamp(v, 0, 1);
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let rgb;
    if (h < 60) rgb = [c, x, 0]; else if (h < 120) rgb = [x, c, 0];
    else if (h < 180) rgb = [0, c, x]; else if (h < 240) rgb = [0, x, c];
    else if (h < 300) rgb = [x, 0, c]; else rgb = [c, 0, x];
    return rgb.map((n) => Math.round((n + m) * 255));
}
function hex(rgb) { return '#' + rgb.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase(); }
function bytes(value) {
    if (!value) return [];
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) return Array.prototype.slice.call(value);
    if (value.data !== undefined) return bytes(value.data);
    if (typeof value === 'object' && typeof value.length === 'number') return Array.prototype.slice.call(value);
    return [];
}
function acceptReply(sid, did) {
    return (u) => (u && u[0] === sid + 0x40 && did.every((v, i) => u[i + 1] === v)) ||
        (u && u[0] === 0x7f && u[1] === sid);
}
function parseModules(bus, uds) {
    if (!uds || uds[0] !== 0x62 || uds[1] !== BUSES[bus].read[0] || uds[2] !== BUSES[bus].read[1]) return null;
    const found = [];
    for (let i = 0; i < RECORDS; i++) {
        const r = uds.slice(3 + i * RECORD_BYTES, 3 + (i + 1) * RECORD_BYTES);
        if (r.length !== RECORD_BYTES || r[0] === 0xff) continue;
        found.push({
            bus, nad: i + 1, location: r[0], part: UPPER_LOC.has(r[0]) ? 'upper' : LOWER_LOC.has(r[0]) ? 'lower' : 'unknown',
            rgb: [r[3], r[2], r[1]], brightness: r[4], fault: !!(r[6] || r[7] || r[8] || r[9]),
        });
    }
    return found;
}
function frameFor(bus, nad, rgb, brightness, seconds) {
    const did = BUSES[bus].write;
    return did.concat([nad, 1, clamp(Math.round(brightness), 0, 100),
        clamp(Math.round(rgb[0]), 0, 254), clamp(Math.round(rgb[1]), 0, 254), clamp(Math.round(rgb[2]), 0, 254), clamp(Math.round(seconds), 1, 254)]);
}
function restoreFrame(bus, nad) { return BUSES[bus].write.concat([nad, 0, 0, 0, 0, 0, 0]); }
function readSlot(v) {
    const raw = v && v.statusMenuAmbientePanoramicRoofInteriorLighting;
    const match = /^FARBAUSWAHL_(\d+)$/.exec(String(raw));
    const n = match ? Number(match[1]) : Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}
function factoryRequest(n) {
    const unfilled = 'SIGNAL_UNBEFUELLT';
    return {
        controlMenuAmbientePanoramicRoofInteriorLighting: 'FARBAUSWAHL_' + n,
        controlModeAmbientePanoramicRoofInteriorLighting: unfilled,
        controlDynamicInteriorLighting: unfilled,
        controlDynamicAmbienteInteriorLighting: unfilled,
        controlHueInteriorLighting: 4095,
        controlHueValueLayer1IndividualGroup: 255,
        controlHueValueLayer2IndividualGroup: 255,
        controlHueValueLayer3IndividualGroup: 255,
        controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting: 255,
    };
}
function shortError(e) { return String(e && e.message || e || 'unknown').replace(/[\r\n]+/g, ' '); }

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const state = {
            page: 'studio', zone: 'all', slot: 1, liveSlot: null, speed: null, speedAt: 0,
            speedAvailable: false, proxy: null, diag: null, modules: [], scan: 'not scanned',
            busy: false, notice: 'Choose a colour, then scan the car to begin.', noticeColor: C.muted,
            scanBusy: false, applyBusy: false, activeCustom: false, renewTimer: null,
            favorites: [], favorite: 0, upperRead: null, lowerRead: null, customUpper: null, customLower: null, customOther: null,
        };
        let stopped = false, renderTimer = null, renderQueued = false;
        let lastAction = Object.create(null), hitboxes = [];
        const favFile = path.join(ctx.dataDir, 'moreambients_favourites.json');
        const freshSpeed = () => !!(state.speedAt && Date.now() - state.speedAt < 8000 && isFiniteNumber(state.speed));
        const hueValue = () => isFiniteNumber(settings.get('hue')) ? settings.get('hue') : 205;
        const saturationValue = () => isFiniteNumber(settings.get('saturation')) ? settings.get('saturation') : 86;
        const brightnessValue = () => isFiniteNumber(settings.get('brightness')) ? settings.get('brightness') : 76;
        const rgb = () => hsvToRgb(hueValue(), saturationValue() / 100, 1);
        const previewRgb = () => hsvToRgb(hueValue(), saturationValue() / 100, brightnessValue() / 100);
        const dimmedRgb = (colour) => colour.rgb.map((n) => Math.round(n * colour.brightness / 100));
        const zoneName = () => state.zone === 'all' ? 'ALL LIGHTS' : state.zone === 'upper' ? 'UPPER / TRIM' : 'LOWER / FOOTWELLS';
        const acceptedText = (u) => u && u[0] === 0x6e ? 'accepted' : u && u[0] === 0x7f ? 'rejected NRC ' + (u[2] == null ? '--' : u[2].toString(16).toUpperCase().padStart(2, '0')) : 'no reply';

        try {
            const saved = JSON.parse(fs.readFileSync(favFile, 'utf8'));
            if (Array.isArray(saved)) state.favorites = saved.slice(0, FAVOURITES).map((x) => x && Array.isArray(x.rgb) && x.rgb.length === 3
                ? { rgb: x.rgb.map((n) => clamp(Number(n) || 0, 0, 255)), brightness: clamp(isFinite(Number(x.brightness)) ? Number(x.brightness) : 76, 10, 100), hue: clamp(isFinite(Number(x.hue)) ? Number(x.hue) : 205, 0, 359), saturation: clamp(isFinite(Number(x.saturation)) ? Number(x.saturation) : 86, 0, 100) }
                : null);
        } catch (e) { state.favorites = []; }

        function setNotice(text, color) { state.notice = text; state.noticeColor = color || C.muted; queueRender(); }
        function queueRender() {
            if (stopped || renderQueued) return;
            renderQueued = true;
            renderTimer = setTimeout(() => {
                renderTimer = null; renderQueued = false;
                Promise.resolve(render()).catch((e) => log.warn('render: ' + shortError(e)));
            }, 55);
        }
        function canChangeColor() {
            if (!freshSpeed()) { setNotice('WAITING FOR A FRESH VEHICLE SPEED SIGNAL', C.amber); return false; }
            if (state.speed > 1.0) { setNotice('STOP THE VEHICLE BEFORE CHANGING LIGHTS', C.amber); return false; }
            return true;
        }
        async function watchSignals() {
            try {
                const watch = await ctx.signals.watch(LIGHT, '1', {
                    statusAmbientLightInteriorColour: (v) => { state.liveSlot = readSlot(v); queueRender(); },
                }, log, { pollMs: 5000 });
                if (watch) { state.proxy = watch.proxy || null; if (watch.shutdown) ctx._moreAmbientWatches.push(watch); }
                if (watch && watch.error) log.warn('BMW ambient palette: ' + watch.error);
            } catch (e) { log.warn('BMW ambient palette signal: ' + shortError(e)); }
            try {
                const watch = await ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
                    statusCarSpeed2: (v) => {
                        const raw = v && v.speedVehicleCentreOfGravity;
                        const speed = isFiniteNumber(raw) && raw !== 65535 ? raw * 0.015625 : null;
                        if (speed !== null && speed >= 0 && speed <= 400) { state.speed = speed; state.speedAt = Date.now(); }
                        else { state.speed = null; state.speedAt = 0; }
                        queueRender();
                    },
                }, log, { pollMs: 2000 });
                if (watch && watch.shutdown) ctx._moreAmbientWatches.push(watch);
                if (watch && watch.error) log.warn('Vehicle speed: ' + watch.error);
            } catch (e) { log.warn('Vehicle speed signal: ' + shortError(e)); }
        }
        ctx._moreAmbientWatches = [];

        async function scanModules() {
            if (state.scanBusy || state.applyBusy || state.busy || stopped) return;
            if (state.activeCustom) await restoreBmw();
            state.scanBusy = true; state.scan = 'scanning'; state.modules = [];
            setNotice('READING THE TWO BMW BODY-CONTROLLER LIGHT BUSES…', C.cyan);
            const found = [];
            try {
                if (!state.diag) state.diag = await new Diag(ctx.signals, log).init();
                if (!state.diag.available) throw new Error(state.diag.error || 'BMW diagnostic link is unavailable');
                for (let bus = 0; bus < BUSES.length; bus++) {
                    const did = BUSES[bus].read;
                    const reply = await state.diag.physical(BDC, 0x22, did, 15000, acceptReply(0x22, did),
                        { pendingTimeoutMs: 15000 });
                    const parsed = parseModules(bus, reply);
                    if (parsed) found.push.apply(found, parsed);
                    else if (reply && reply[0] === 0x7f) log.info('ambient scan: bus ' + (bus + 1) + ' returned NRC ' + (reply[2] || 0).toString(16));
                }
                state.modules = found;
                state.scan = found.length ? found.length + ' MODULES FOUND' : 'NO MODULES ANSWERED';
                state.upperRead = average(found.filter((m) => m.part === 'upper' && !m.fault));
                state.lowerRead = average(found.filter((m) => m.part === 'lower' && !m.fault));
                if (found.length) setNotice('READ ' + found.length + ' LIGHT MODULES · NO COLOUR WAS CHANGED', C.green);
                else setNotice('NO RGB MODULES REPLIED · TRY THE BMW FACTORY PALETTE', C.amber);
            } catch (e) {
                state.scan = 'SCAN FAILED';
                setNotice('SCAN FAILED · ' + shortError(e).slice(0, 76), C.red);
                log.warn('ambient module scan: ' + shortError(e));
            } finally { state.scanBusy = false; queueRender(); }
        }
        function average(list) {
            if (!list || !list.length) return null;
            return [0, 1, 2].map((i) => Math.round(list.reduce((sum, m) => sum + m.rgb[i], 0) / list.length));
        }
        async function sendFrame(bus, nad, colour) {
            const did = BUSES[bus].write;
            const data = frameFor(bus, nad, colour.rgb, colour.brightness, HOLD_SECONDS);
            const reply = await state.diag.physical(BDC, 0x2e, data, 1800, acceptReply(0x2e, did),
                { retryBaseMs: 80, maxRetries: 2 });
            return { ok: !!(reply && reply[0] === 0x6e && reply[1] === did[0] && reply[2] === did[1]), why: acceptedText(reply) };
        }
        async function sendRestore(bus, nad) {
            const did = BUSES[bus].write;
            const data = restoreFrame(bus, nad);
            const reply = await state.diag.physical(BDC, 0x2e, data, 1800, acceptReply(0x2e, did),
                { retryBaseMs: 80, maxRetries: 2 });
            return !!(reply && reply[0] === 0x6e && reply[1] === did[0] && reply[2] === did[1]);
        }
        function activeZoneLooks() {
            const looks = [];
            if (state.customUpper) looks.push({ zone: 'upper', colour: state.customUpper,
                modules: state.modules.filter((m) => !m.fault && m.part === 'upper') });
            if (state.customLower) looks.push({ zone: 'lower', colour: state.customLower,
                modules: state.modules.filter((m) => !m.fault && m.part === 'lower') });
            if (state.customOther) looks.push({ zone: 'other', colour: state.customOther,
                modules: state.modules.filter((m) => !m.fault && m.part === 'unknown') });
            return looks.filter((look) => look.modules.length);
        }
        async function applyCustom(isRenewal) {
            if (stopped || state.applyBusy || state.scanBusy || state.busy) return;
            if (!canChangeColor()) {
                if (isRenewal) {
                    state.activeCustom = false; state.customUpper = null; state.customLower = null; state.customOther = null; state.renewTimer = null;
                    setNotice('CUSTOM COLOUR WILL RETURN TO BMW WHEN ITS SHORT HOLD EXPIRES', C.amber);
                }
                return;
            }
            if (!state.modules.length) {
                if (!isRenewal) setNotice('SCAN LIGHT MODULES FIRST · THIS ONLY READS THE CAR', C.amber);
                return;
            }
            const chosen = state.zone === 'all' ? ['upper', 'lower', 'other'] : [state.zone];
            const colour = { rgb: rgb(), brightness: brightnessValue() };
            const healthy = state.modules.filter((m) => !m.fault);
            const applicable = chosen.filter((zone) => healthy.some((m) => zone === 'other' ? m.part === 'unknown' : m.part === zone));
            if (!applicable.length) { setNotice('NO HEALTHY LIGHT MODULES FOUND IN THIS ZONE', C.amber); return; }
            if (applicable.indexOf('upper') >= 0) state.customUpper = Object.assign({}, colour);
            if (applicable.indexOf('lower') >= 0) state.customLower = Object.assign({}, colour);
            if (applicable.indexOf('other') >= 0) state.customOther = Object.assign({}, colour);
            const looks = activeZoneLooks();
            if (!looks.length) { setNotice('NO HEALTHY MODULES FOUND IN THIS ZONE', C.amber); return; }
            clearTimeout(state.renewTimer); state.renewTimer = null;
            state.applyBusy = true;
            if (!isRenewal) setNotice('SENDING COLOUR TO ' + looks.map((x) => x.modules.length).reduce((a, b) => a + b, 0) + ' DISCOVERED MODULES…', C.cyan);
            let ok = 0, failed = 0;
            try {
                // Renew both selected zones when needed; only use module addresses returned by the live BDC scan.
                for (const look of looks) for (const m of look.modules) {
                    const result = await sendFrame(m.bus, m.nad, look.colour); if (result.ok) ok++; else failed++;
                }
                state.activeCustom = !!ok;
                if (ok) {
                    if (!isRenewal) setNotice('COMMAND ACKNOWLEDGED BY ' + ok + ' MODULES' + (failed ? ' · ' + failed + ' NO ACK' : '') + ' · CHECK THE LIGHTS', failed ? C.amber : C.green);
                    clearTimeout(state.renewTimer);
                    state.renewTimer = setTimeout(() => applyCustom(true), RENEW_MS);
                } else {
                    state.customUpper = null; state.customLower = null; state.customOther = null; state.activeCustom = false;
                    if (!isRenewal) setNotice('BDC DID NOT ACCEPT THE COLOUR · BMW LIGHTING IS UNCHANGED', C.red);
                }
            } catch (e) {
                state.activeCustom = false; state.customUpper = null; state.customLower = null; state.customOther = null;
                if (!isRenewal) setNotice('COLOUR COMMAND FAILED · ' + shortError(e).slice(0, 70), C.red);
                log.warn('ambient write: ' + shortError(e));
            } finally { state.applyBusy = false; queueRender(); }
        }
        async function restoreBmw() {
            if (state.applyBusy || state.scanBusy || state.busy) return;
            clearTimeout(state.renewTimer); state.renewTimer = null; state.activeCustom = false;
            if (!state.modules.length || !state.diag || !state.diag.available) {
                state.upperRead = null; state.lowerRead = null; state.customUpper = null; state.customLower = null; state.customOther = null;
                setNotice('RESTORE LINK UNAVAILABLE · THE SHORT BMW OVERRIDE WILL EXPIRE BY ITSELF', C.amber);
                return;
            }
            state.busy = true; setNotice('RESTORING BMW LIGHTING…', C.cyan);
            let ok = 0, failed = 0;
            try {
                for (const m of state.modules) { if (await sendRestore(m.bus, m.nad)) ok++; else failed++; }
                state.upperRead = null; state.lowerRead = null; state.customUpper = null; state.customLower = null; state.customOther = null;
                setNotice('BMW LIGHTING RESTORED · ' + ok + ' MODULES' + (failed ? ' · ' + failed + ' DID NOT ACK' : ''), failed ? C.amber : C.green);
            } catch (e) { setNotice('RESTORE FAILED · ' + shortError(e).slice(0, 72), C.red); log.warn('ambient restore: ' + shortError(e)); }
            finally { state.busy = false; queueRender(); }
        }
        async function setFactorySlot(n) {
            if (state.activeCustom) await restoreBmw();
            if (!canChangeColor()) return;
            if (!state.proxy) { setNotice('BMW FACTORY COLOUR CONTROL IS NOT AVAILABLE', C.amber); return; }
            state.slot = clamp(n, 1, 12);
            try {
                await ctx.signals.set(state.proxy, 'ambientLightInteriorColour', factoryRequest(state.slot));
                setNotice('BMW COLOUR SLOT ' + String(state.slot).padStart(2, '0') + ' REQUESTED · WAITING FOR VEHICLE STATUS', C.green);
            } catch (e) { setNotice('BMW COLOUR REQUEST FAILED · ' + shortError(e).slice(0, 65), C.red); log.warn('factory colour: ' + shortError(e)); }
        }
        function changeSetting(key, delta, min, max) {
            const n = clamp(Number(settings.get(key) || 0) + delta, min, max);
            settings.set(key, n); queueRender();
        }
        function saveFavorite() {
            const col = rgb();
            const item = { rgb: col, hue: settings.get('hue'), saturation: settings.get('saturation'), brightness: settings.get('brightness') };
            state.favorites[state.favorite] = item;
            try { fs.writeFileSync(favFile + '.tmp', JSON.stringify(state.favorites)); fs.renameSync(favFile + '.tmp', favFile); }
            catch (e) { log.warn('saving ambient favourite: ' + shortError(e)); }
            setNotice('LOOK ' + (state.favorite + 1) + ' SAVED · ' + hex(col), C.green);
        }
        function loadFavorite() {
            const item = state.favorites[state.favorite];
            if (!item) { setNotice('LOOK ' + (state.favorite + 1) + ' IS EMPTY · SAVE A COLOUR FIRST', C.amber); return; }
            settings.set('hue', item.hue); settings.set('saturation', item.saturation); settings.set('brightness', item.brightness);
            queueRender(); setNotice('LOOK ' + (state.favorite + 1) + ' LOADED · PRESS APPLY TO CHANGE THE CAR', C.cyan);
        }
        function chooseFavorite(step) { state.favorite = (state.favorite + step + FAVOURITES) % FAVOURITES; queueRender(); }
        function changeZone() { state.zone = state.zone === 'all' ? 'upper' : state.zone === 'upper' ? 'lower' : 'all'; queueRender(); }
        function toggleView() { state.page = state.page === 'studio' ? 'bmw' : 'studio'; queueRender(); }
        const actions = {
            view: toggleView, zone: changeZone,
            hueMinus: () => changeSetting('hue', -15, 0, 345), huePlus: () => changeSetting('hue', 15, 0, 345),
            satMinus: () => changeSetting('saturation', -10, 0, 100), satPlus: () => changeSetting('saturation', 10, 0, 100),
            brightnessMinus: () => changeSetting('brightness', -10, 10, 100), brightnessPlus: () => changeSetting('brightness', 10, 10, 100),
            scan: scanModules, apply: () => applyCustom(false), restore: restoreBmw,
            factoryPrev: () => { state.slot = state.liveSlot || state.slot; return setFactorySlot(state.slot <= 1 ? 12 : state.slot - 1); },
            factoryNext: () => { state.slot = state.liveSlot || state.slot; return setFactorySlot(state.slot >= 12 ? 1 : state.slot + 1); },
            factoryApply: () => setFactorySlot(state.slot), favPrev: () => chooseFavorite(-1), favNext: () => chooseFavorite(1),
            favSave: saveFavorite, favLoad: loadFavorite,
        };
        const clickBindings = {
            BTN_VIEW: 'view', BTN_ZONE: 'zone', BTN_HUE_MINUS: 'hueMinus', BTN_HUE_PLUS: 'huePlus',
            BTN_SAT_MINUS: 'satMinus', BTN_SAT_PLUS: 'satPlus', BTN_BRIGHTNESS_MINUS: 'brightnessMinus',
            BTN_BRIGHTNESS_PLUS: 'brightnessPlus', BTN_SCAN: 'scan', BTN_APPLY: 'apply', BTN_RESTORE: 'restore',
            BTN_FACTORY_PREV: 'factoryPrev', BTN_FACTORY_NEXT: 'factoryNext', BTN_FACTORY_APPLY: 'factoryApply',
            BTN_FAV_PREV: 'favPrev', BTN_FAV_NEXT: 'favNext', BTN_FAV_SAVE: 'favSave', BTN_FAV_LOAD: 'favLoad',
        };
        Object.keys(clickBindings).forEach((button) => {
            const key = clickBindings[button];
            ui.onClick(button, () => {
                const now = Date.now(); if (lastAction[key] && now - lastAction[key] < 260) return;
                lastAction[key] = now; return actions[key]();
            });
            if (ctx.hideButton) ctx.hideButton(button);
        });

        function addButton(cv, x, y, w, h, label, key, options) {
            const o = options || {}, accent = o.accent || C.cyan;
            cv.roundRect(x, y, w, h, 8, o.primary ? '#1C2B39' : '#151A23');
            cv.strokeRoundRect(x, y, w, h, 8, 1.2, o.primary ? accent : C.edge);
            if (o.primary) cv.fillRect(x + 10, y + 7, 3, h - 14, accent);
            cv.text(label, x + w / 2, y + h / 2 + 5, o.size || 12, o.primary ? C.white : C.muted,
                { align: 'center', font: 'bold', spacing: 0.65 });
            if (key) hitboxes.push({ x, y, w, h, key });
        }
        function drawWheel(cv, selected) {
            const cx = 265, cy = 290, inner = 86, outer = 139;
            for (let i = 0; i < 72; i++) cv.arc(cx, cy, inner, outer, i * 5, (i + 1) * 5 + 0.7,
                hex(hsvToRgb(i * 5, 1, 1)));
            cv.circle(cx, cy, inner - 9, '#111722');
            cv.circle(cx, cy, inner - 10, selected);
            cv.strokeRoundRect(cx - 74, cy - 28, 148, 56, 18, 1.5, '#FFFFFF');
            cv.text(hex(rgb()), cx, cy + 4, 17, '#FFFFFF', { align: 'center', font: 'bold', spacing: 0.6 });
            const angle = hueValue() - 90, radius = (inner + outer) / 2;
            const px = cx + Math.cos(angle * Math.PI / 180) * radius, py = cy + Math.sin(angle * Math.PI / 180) * radius;
            cv.circle(px, py, 11, '#FFFFFF'); cv.circle(px, py, 7, selected);
            cv.text('TAP RING  ·  HUE + SATURATION', cx, 457, 10, C.muted, { align: 'center', font: 'bold', spacing: 1 });
            return { cx, cy, inner, outer };
        }
        function drawCabin(cv) {
            const x = 795, y = 137, w = 410, h = 108;
            const upper = state.customUpper ? dimmedRgb(state.customUpper)
                : state.upperRead || (state.zone === 'all' || state.zone === 'upper' ? previewRgb() : null);
            const lower = state.customLower ? dimmedRgb(state.customLower)
                : state.lowerRead || (state.zone === 'all' || state.zone === 'lower' ? previewRgb() : null);
            cv.roundRect(x, y, w, h, 34, '#0A0D13');
            cv.strokeRoundRect(x, y, w, h, 34, 2, '#596476');
            cv.roundRect(x + 96, y + 12, w - 192, h - 24, 27, '#121824');
            cv.strokeRoundRect(x + 96, y + 12, w - 192, h - 24, 27, 1.2, C.edge);
            cv.fillRect(x + 139, y + 43, 132, 2, C.edge);
            cv.fillRect(x + 200, y + 30, 2, 47, C.edge);
            const upperC = upper ? hex(upper) : '#384352', lowerC = lower ? hex(lower) : '#384352';
            cv.roundRect(x + 21, y + 23, w - 42, 7, 3, upperC);
            cv.roundRect(x + 21, y + 40, 7, 50, 3, upperC); cv.roundRect(x + w - 28, y + 40, 7, 50, 3, upperC);
            cv.roundRect(x + 45, y + 72, 82, 6, 3, lowerC); cv.roundRect(x + w - 127, y + 72, 82, 6, 3, lowerC);
            cv.circle(x + 52, y + 83, 3, lowerC); cv.circle(x + w - 52, y + 83, 3, lowerC);
            cv.text('UPPER', x + 6, y + 18, 8, upperC, { font: 'bold', spacing: 0.7 });
            cv.text('LOWER', x + 6, y + h - 1, 8, lowerC, { font: 'bold', spacing: 0.7 });
            cv.text(state.modules.length ? String(state.modules.filter((m) => !m.fault).length) + ' READY' : 'WAITING FOR SCAN',
                x + w + 36, y + 40, 11, state.modules.length ? C.green : C.dim, { font: 'bold', spacing: 0.6 });
            cv.text(state.scan.toUpperCase(), x + w + 36, y + 62, 9, C.muted, { font: 'bold', spacing: 0.5 });
            cv.text(freshSpeed() ? state.speed.toFixed(0) + ' KM/H' : 'SPEED --', x + w + 36, y + 88, 9,
                freshSpeed() ? state.speed <= 1 ? C.green : C.amber : C.dim, { font: 'bold', spacing: 0.7 });
        }
        function drawStudio(cv, t) {
            const col = rgb(), swatch = hex(previewRgb());
            G.panel(cv, t, 24, 67, 675, 427, 'COLOUR STUDIO');
            G.panel(cv, t, 715, 67, 861, 195, 'CABIN PREVIEW');
            G.panel(cv, t, 715, 276, 861, 218, 'LIGHTING CONTROLS');
            drawWheel(cv, swatch);

            cv.text('ACTIVE COLOUR', 458, 126, 10, C.muted, { font: 'bold', spacing: 1.2 });
            cv.roundRect(458, 144, 207, 62, 13, '#0A0D13');
            cv.strokeRoundRect(458, 144, 207, 62, 13, 1, C.edge);
            cv.roundRect(472, 158, 39, 34, 8, swatch);
            cv.text('RGB  ' + col.join(' / '), 522, 170, 12, C.white, { font: 'bold' });
            cv.text(zoneName(), 522, 189, 9, C.muted, { font: 'bold', spacing: 0.6 });
            cv.text('QUICK HUES', 458, 239, 10, C.muted, { font: 'bold', spacing: 1.1 });
            const quick = [0, 28, 52, 115, 175, 205, 240, 280, 325, 0];
            const quickSat = [100, 100, 100, 88, 88, 88, 82, 78, 76, 0];
            quick.forEach((h, i) => {
                const x = 458 + (i % 5) * 42, y = 254 + Math.floor(i / 5) * 39;
                const color = hex(hsvToRgb(h, quickSat[i] / 100, 1));
                cv.roundRect(x, y, 32, 28, 8, color);
                cv.strokeRoundRect(x, y, 32, 28, 8, 1, '#606D80');
                hitboxes.push({ x, y, w: 32, h: 28, key: 'quick', hue: h, sat: quickSat[i] });
            });
            cv.text('Tap a swatch or ring to preview. The car changes only after Apply.', 458, 364, 9, C.dim, { font: 'bold' });
            cv.text(state.activeCustom ? 'CUSTOM COLOUR ACTIVE' : 'BMW COLOUR STAYS ACTIVE UNTIL APPLY', 458, 390, 8,
                state.activeCustom ? C.green : C.dim, { font: 'bold', spacing: 0.55 });

            drawCabin(cv);
            cv.text('STATIC RGB', 1248, 145, 9, C.cyan, { font: 'bold', spacing: 0.8 });
            cv.text('NO FLASHING', 1248, 166, 9, C.dim, { font: 'bold', spacing: 0.8 });

            const left = 740;
            addButton(cv, left, 311, 150, 38, 'ZONE  ' + (state.zone === 'all' ? 'ALL' : state.zone.toUpperCase()), 'zone', { primary: true, accent: C.violet, size: 10 });
            addButton(cv, left + 164, 311, 74, 38, 'HUE −', 'hueMinus');
            cv.text(String(hueValue()) + '°', left + 286, 335, 16, C.white, { align: 'center', font: 'bold' });
            addButton(cv, left + 334, 311, 74, 38, 'HUE +', 'huePlus');
            addButton(cv, left + 427, 311, 74, 38, 'SAT −', 'satMinus');
            cv.text(String(saturationValue()) + '%', left + 548, 335, 14, C.white, { align: 'center', font: 'bold' });
            addButton(cv, left + 596, 311, 74, 38, 'SAT +', 'satPlus');

            cv.text('BRIGHTNESS', left, 384, 9, C.muted, { font: 'bold', spacing: 1.1 });
            cv.roundRect(left + 116, 369, 332, 12, 6, '#222B37');
            cv.roundRect(left + 116, 369, Math.round(332 * (brightnessValue() / 100)), 12, 6, C.cyan);
            cv.circle(left + 116 + Math.round(332 * (brightnessValue() / 100)), 375, 10, C.white);
            cv.text(String(brightnessValue()) + '%', left + 485, 384, 11, C.white, { font: 'bold' });
            addButton(cv, left + 542, 359, 58, 34, '−', 'brightnessMinus', { accent: C.violet, size: 18 });
            addButton(cv, left + 609, 359, 58, 34, '+', 'brightnessPlus', { accent: C.violet, size: 18 });
            hitboxes.push({ x: left + 115, y: 357, w: 335, h: 34, key: 'brightnessTrack' });

            addButton(cv, left, 419, 152, 42, state.scanBusy ? 'SCANNING…' : 'SCAN MODULES', 'scan', { accent: C.blue });
            addButton(cv, left + 164, 419, 204, 42, state.applyBusy ? 'SENDING…' : 'APPLY TO CAR', 'apply', { primary: true, accent: C.cyan, size: 12 });
            addButton(cv, left + 380, 419, 164, 42, 'BMW ORIGINAL', 'restore', { accent: C.amber });
            addButton(cv, left + 556, 419, 105, 42, 'SAVE LOOK', 'favSave', { accent: C.violet, size: 9 });
            cv.text('FAV ' + (state.favorite + 1) + '/' + FAVOURITES + (state.favorites[state.favorite] ? '  ·  SAVED' : '  ·  EMPTY'),
                left, 480, 9, C.dim, { font: 'bold', spacing: 0.6 });
            addButton(cv, left + 152, 466, 76, 24, '◀', 'favPrev', { accent: C.violet, size: 11 });
            addButton(cv, left + 236, 466, 76, 24, 'LOAD', 'favLoad', { accent: C.violet, size: 9 });
            addButton(cv, left + 320, 466, 76, 24, '▶', 'favNext', { accent: C.violet, size: 11 });
            cv.text(state.notice, 1553, 480, 8, state.noticeColor, { align: 'right', font: 'bold', spacing: 0.4 });
        }
        function drawBmwPage(cv, t) {
            G.panel(cv, t, 24, 67, 1552, 427, 'BMW FACTORY COLOURS');
            cv.text('These are BMW colour slots. Their visible colours depend on the vehicle configuration.', 58, 111, 12, C.muted, { font: 'bold' });
            cv.text('SELECTED SLOT', 1377, 110, 9, C.dim, { align: 'right', font: 'bold', spacing: 1 });
            cv.text(String(state.slot).padStart(2, '0'), 1522, 113, 21, C.cyan, { align: 'right', font: 'bold' });
            const x0 = 58, y0 = 149, cw = 350, ch = 73, gapX = 22, gapY = 18;
            for (let n = 1; n <= 12; n++) {
                const col = (n - 1) % 4, row = Math.floor((n - 1) / 4);
                const x = x0 + col * (cw + gapX), y = y0 + row * (ch + gapY), active = n === state.slot || n === state.liveSlot;
                cv.roundRect(x, y, cw, ch, 11, active ? '#17293A' : '#121720');
                cv.strokeRoundRect(x, y, cw, ch, 11, active ? 1.8 : 1, active ? C.cyan : C.edge);
                cv.roundRect(x + 16, y + 17, 40, 39, 9, active ? C.cyan : '#263244');
                cv.text('BMW COLOUR SLOT  ' + String(n).padStart(2, '0'), x + 75, y + 34, 13, C.white, { font: 'bold', spacing: 0.7 });
                cv.text(n === state.liveSlot ? 'CURRENTLY REPORTED BY VEHICLE' : 'TAP TO REQUEST THIS FACTORY COLOUR',
                    x + 75, y + 54, 8, n === state.liveSlot ? C.green : C.dim, { font: 'bold', spacing: 0.45 });
                hitboxes.push({ x, y, w: cw, h: ch, key: 'slot', slot: n });
            }
            addButton(cv, 58, 441, 224, 38, '← CUSTOM COLOUR STUDIO', 'view', { accent: C.violet, size: 10 });
            addButton(cv, 1297, 441, 95, 38, 'PREVIOUS', 'factoryPrev', { size: 9 });
            addButton(cv, 1401, 441, 75, 38, 'APPLY', 'factoryApply', { primary: true, size: 9 });
            addButton(cv, 1485, 441, 75, 38, 'NEXT', 'factoryNext', { size: 9 });
            cv.text(state.notice, 58, 486, 9, state.noticeColor, { font: 'bold', spacing: 0.5 });
        }
        async function render() {
            if (stopped || !ui.isVisible('MAIN')) return;
            hitboxes = [];
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(C.bg);
            G.frame(cv, t, ['MoreAmbients'], 0, [{ text: state.activeCustom ? 'CUSTOM RGB' : 'BMW LIGHTING', color: state.activeCustom ? 'good' : 'dim' }]);
            cv.text('MORE AMBIENTS', 28, 60, 16, C.white, { font: 'bold', spacing: 1.5 });
            cv.text('CABIN LIGHTING STUDIO', 194, 59, 8, C.dim, { font: 'bold', spacing: 1.2 });
            cv.roundRect(1284, 41, 146, 24, 12, state.activeCustom ? '#143629' : '#171C26');
            cv.circle(1301, 53, 4, state.activeCustom ? C.green : C.dim);
            cv.text(state.activeCustom ? 'CUSTOM ACTIVE' : 'BMW CONTROL', 1313, 57, 8, state.activeCustom ? C.green : C.muted,
                { font: 'bold', spacing: 0.7 });
            cv.roundRect(1441, 41, 133, 24, 12, freshSpeed() ? state.speed <= 1 ? '#143629' : '#3B2D19' : '#1D2028');
            cv.text(freshSpeed() ? state.speed.toFixed(0) + ' KM/H' : 'SPEED --', 1508, 57, 8,
                freshSpeed() ? state.speed <= 1 ? C.green : C.amber : C.dim, { align: 'center', font: 'bold' });
            addButton(cv, 1120, 41, 146, 24, state.page === 'studio' ? 'BMW PALETTE' : 'COLOUR STUDIO', 'view', { accent: C.violet, size: 8 });
            cv.fillRect(24, 66, 1552, 1, '#28313E');
            if (state.page === 'studio') drawStudio(cv, t); else drawBmwPage(cv, t);
            return ui.image('MAIN_GFX', cv);
        }
        function hitTest(x, y) {
            for (let i = hitboxes.length - 1; i >= 0; i--) {
                const b = hitboxes[i]; if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
                if (b.key === 'quick') { settings.set('hue', b.hue); settings.set('saturation', b.sat); queueRender(); return; }
                if (b.key === 'slot') { state.slot = b.slot; return setFactorySlot(b.slot); }
                if (b.key === 'brightnessTrack') {
                    settings.set('brightness', clamp(Math.round((x - (740 + 116)) / 332 * 100 / 10) * 10, 10, 100));
                    queueRender(); return;
                }
                if (b.key && actions[b.key]) return actions[b.key]();
            }
            if (state.page === 'studio') {
                const dx = x - 265, dy = y - 290, r = Math.sqrt(dx * dx + dy * dy);
                if (r >= 80 && r <= 148) {
                    let hue = Math.round((Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360);
                    hue = Math.round(hue / 15) * 15 % 360;
                    settings.set('hue', hue);
                    settings.set('saturation', clamp(Math.round(((r - 80) / 68 * 100) / 10) * 10, 0, 100));
                    queueRender();
                }
            }
        }
        ctx.onTap((x, y) => { try { hitTest(x, y); } catch (e) { setNotice('CONTROL FAILED · ' + shortError(e), C.red); } });
        ctx.onLayout(queueRender);
        ui.onVisible((name, visible) => { if (name === 'MAIN' && visible) render().catch((e) => log.warn('render: ' + shortError(e))); });

        await watchSignals();
        try { state.diag = await new Diag(ctx.signals, log).init(); state.diag.quiet = true; state.diag.busyLog = false; }
        catch (e) { log.warn('TASU setup: ' + shortError(e)); }
        if (ui.isVisible('MAIN')) render().catch((e) => log.warn('first render: ' + shortError(e)));
        ctx.app.on('shutdown', () => {
            stopped = true; clearTimeout(state.renewTimer); clearTimeout(renderTimer);
            ctx._moreAmbientWatches.forEach((sub) => { try { if (sub && sub.shutdown) Promise.resolve(sub.shutdown()).catch(() => {}); } catch (e) {} });
            if (state.activeCustom && state.diag && state.diag.available) {
                (async () => {
                    for (const m of state.modules) {
                        try { await sendRestore(m.bus, m.nad); } catch (e) { log.warn('shutdown restore: ' + shortError(e)); }
                    }
                })();
            }
        });
    },
});
