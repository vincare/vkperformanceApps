'use strict';

/** MoreAmbients: BMW's reversible interior-colour selection plus discovered-module RGB control. */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Sheet = require('./sheet_ui');
const BgArt = require('./bg_art');
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
const OEM_COLORS = [
    ['DARK RED', '#6B0F1A'], ['RED', '#F0172F'], ['CRIMSON', '#B00035'], ['RUBY', '#8B001D'], ['BURGUNDY', '#5C0A24'], ['CORAL', '#FF735A'],
    ['ORANGE', '#FF5A1F'], ['AMBER', '#FF9D00'], ['GOLD', '#FFC400'], ['YELLOW', '#FFE600'], ['LIME', '#B7E000'], ['MINT', '#51D7A1'],
    ['GREEN', '#00C853'], ['EMERALD', '#007F5F'], ['TURQUOISE', '#00BFA5'], ['TEAL', '#008C95'], ['CYAN', '#00D7E8'], ['ICE BLUE', '#8CEBFF'],
    ['SKY BLUE', '#4DB8FF'], ['BMW BLUE', '#1582FF'], ['ELECTRIC BLUE', '#005CFF'], ['DEEP BLUE', '#1533B8'], ['NAVY BLUE', '#14204F'], ['INDIGO', '#3F32B8'],
    ['VIOLET', '#6F37D5'], ['PURPLE', '#9A35D5'], ['MAGENTA', '#E100B5'], ['HOT PINK', '#FF3C9D'], ['PINK', '#FF75B5'], ['ROSE', '#FF557A'],
    ['LAVENDER', '#BCA7FF'], ['LILAC', '#D4A7FF'], ['WARM WHITE', '#FFD9A8'], ['SOFT WHITE', '#FFEED5'], ['COOL WHITE', '#E9F5FF'], ['ICE WHITE', '#F7FCFF'],
].map(([name, color]) => ({ name, color, rgb: [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) * 254 / 255) }));
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
function factoryRequest(n, brightness) {
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
        controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting: brightness === undefined ? 255 : brightness,
    };
}
function shortError(e) { return String(e && e.message || e || 'unknown').replace(/[\r\n]+/g, ' '); }

/** The Colour panel's 24 named colours. */
const PALETTE = [
    ['Ice', '#DCEEFF'], ['Ivory', '#FFF0D6'], ['Champagne', '#EBC99C'], ['Citrine', '#FFD054'],
    ['Honey', '#F5AA24'], ['Ember', '#FF8A3D'], ['Copper', '#CC632E'], ['Coral', '#FF6F70'],
    ['Ruby', '#F53D57'], ['Crimson', '#B91F43'], ['Flamingo', '#FF65AD'], ['Fuchsia', '#E728B9'],
    ['Orchid', '#DE72F3'], ['Lavender', '#C5ACFF'], ['Amethyst', '#A378FF'], ['Indigo', '#6145D8'],
    ['Sapphire', '#4775FF'], ['Azure', '#45A9FF'], ['Glacier', '#19D3F2'], ['Lagoon', '#22C9AF'],
    ['Mint', '#9DF2CD'], ['Jade', '#65D88F'], ['Emerald', '#19A85D'], ['Lime', '#B7EA42'],
].map(([name, c1]) => ({ name, c1 }));

/** The Combos panel's 20 two-colour combinations: c1 = dash (upper zone), c2 = footwells (lower zone). */
const COMBOS = [
    ['Glacier Ember', '#19D3F2', '#FF8A3D'], ['Midnight Ice', '#4775FF', '#DCEEFF'],
    ['Polar Night', '#DCEEFF', '#6145D8'], ['Ocean Drive', '#45A9FF', '#22C9AF'],
    ['Neon Circuit', '#19D3F2', '#B7EA42'], ['Aurora', '#19A85D', '#A378FF'],
    ['Violet Coast', '#A378FF', '#45A9FF'], ['Ultraviolet', '#6145D8', '#E728B9'],
    ['Miami', '#FF65AD', '#19D3F2'], ['Soft Dusk', '#C5ACFF', '#FF6F70'],
    ['Orchid Pearl', '#DE72F3', '#FFF0D6'], ['Ruby Line', '#F53D57', '#B91F43'],
    ['Velvet Night', '#B91F43', '#C5ACFF'], ['Sunset', '#FF6F70', '#F5AA24'],
    ['Golden Hour', '#EBC99C', '#FFD054'], ['Copper Lounge', '#CC632E', '#FFF0D6'],
    ['Blue Hour', '#4775FF', '#EBC99C'], ['Mint Frost', '#9DF2CD', '#DCEEFF'],
    ['Jade Coast', '#65D88F', '#22C9AF'], ['Emerald Gold', '#19A85D', '#FFD054'],
].map(([name, c1, c2]) => ({ name, c1, c2 }));

function hexToRgbScaled(h) {
    return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) * 254 / 255);
}

/** The Zones page: pick which zone the colour controls target. */
const ZONE_ROWS = [
    { name: 'All zones', zone: 'all' }, { name: 'Dashboard (upper)', zone: 'upper' },
    { name: 'Footwells (lower)', zone: 'lower' },
];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const state = {
            page: 'studio', zone: 'all', slot: 1, liveSlot: null, speed: null, speedAt: 0,
            speedAvailable: false, proxy: null, diag: null, modules: [], scan: 'not scanned',
            busy: false, notice: 'Module scan starts automatically when the app opens.', noticeColor: C.muted,
            scanBusy: false, applyBusy: false, activeCustom: false, renewTimer: null,
            oemPaletteOpen: false, oemSelected: null, oemBackground: 62, oemAccent: 76,
            oemNight: false, oemEnabled: true, oemDynamic: true, oemFocus: 0, oemWantApply: false,
            oemPendingTarget: null, oemPendingAt: 0, oemToggleBusy: false,
            blackoutOverride: false, blackoutApplying: false, blackoutLastAttemptAt: 0,
            oemScroll: 0, oemScrollMax: 0,
            detail: null, detailScroll: 0, detailScrollMax: 0, selColour: -1, selCombo: -1, previewChoice: null,
            detailFocus: -1, look: null, pendingLook: false, oemLockBusy: false,
            favorites: [], favorite: 0, upperRead: null, lowerRead: null, customUpper: null, customLower: null, customOther: null,
        };
        let stopped = false, renderTimer = null, autoScanTimer = null, renderQueued = false;
        let lastAction = Object.create(null), hitboxes = [], wheelGeom = null;
        let lastHudGeom = null, lastDetGeom = null, lastFocusKey = null, focusPoll = null;
        let lastOemLockAt = 0;
        const favFile = path.join(ctx.dataDir, 'moreambients_favourites.json');
        const lookFile = path.join(ctx.dataDir, 'moreambients_look.json');
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

        try {
            const saved = JSON.parse(fs.readFileSync(lookFile, 'utf8'));
            if (saved && typeof saved === 'object') {
                state.look = saved.look && typeof saved.look === 'object' ? saved.look : null;
                if (saved.oemSelected && saved.oemSelected.rgb) {
                    const match = OEM_COLORS.find((c) => c.name === saved.oemSelected.name);
                    state.oemSelected = match || saved.oemSelected;
                }
                state.selColour = isFiniteNumber(saved.selColour) ? saved.selColour : -1;
                state.selCombo = isFiniteNumber(saved.selCombo) ? saved.selCombo : -1;
                state.previewChoice = saved.previewChoice || null;
                if (saved.zone === 'all' || saved.zone === 'upper' || saved.zone === 'lower') state.zone = saved.zone;
                if (saved.oemEnabled === false) state.oemEnabled = false;
                if (isFiniteNumber(saved.oemBackground)) state.oemBackground = clamp(saved.oemBackground, 10, 100);
                if (isFiniteNumber(saved.oemAccent)) state.oemAccent = clamp(saved.oemAccent, 10, 100);
                state.oemNight = !!saved.oemNight;
                state.oemDynamic = saved.oemDynamic !== false;
            }
        } catch (e) { /* first run · keep defaults */ }
        function saveLook() {
            try {
                fs.writeFileSync(lookFile, JSON.stringify({
                    look: state.look, selColour: state.selColour, selCombo: state.selCombo,
                    oemSelected: state.oemSelected && state.oemSelected.name ? { name: state.oemSelected.name } : null,
                    previewChoice: state.previewChoice, zone: state.zone, oemEnabled: state.oemEnabled,
                    oemBackground: state.oemBackground, oemAccent: state.oemAccent,
                    oemNight: state.oemNight, oemDynamic: state.oemDynamic,
                }));
            } catch (e) { log.warn('look persist: ' + shortError(e)); }
        }

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
                    statusAmbientLightInteriorColour: (v) => {
                        const slot = readSlot(v);
                        const slotChanged = slot !== null && slot !== state.liveSlot;
                        state.liveSlot = slot;
                        const brightness = v && v.statusBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting;
                        if (isFiniteNumber(brightness)) {
                            const reportedOn = brightness !== 0;
                            if (state.blackoutOverride) {
                                state.oemEnabled = false;
                            } else if (state.oemPendingTarget !== null && reportedOn !== state.oemPendingTarget
                                && Date.now() - state.oemPendingAt < 12000) {
                                // Keep the requested state while the polled BMW status catches up.
                            } else {
                                if (state.oemPendingTarget !== null && reportedOn !== state.oemPendingTarget) {
                                    setNotice('BMW DID NOT CONFIRM THE AMBIENT LIGHT SETTING', C.amber);
                                }
                                state.oemPendingTarget = null;
                                state.oemEnabled = reportedOn;
                            }
                        }
                        // OEM menu colour pick (slot changed) while our LIN look is applied
                        // + Ambient lighting ON → overwrite it back. OFF toggle lets OEM through.
                        if (slotChanged && state.oemEnabled && state.look && state.activeCustom && !state.oemLockBusy
                            && Date.now() - lastOemLockAt > 4000) {
                            lastOemLockAt = Date.now(); state.oemLockBusy = true;
                            reapplyLook('OEM MENU CHANGE OVERRIDDEN · APP COLOUR KEPT').finally(() => { state.oemLockBusy = false; });
                        }
                        queueRender();
                    },
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
                        if (state.pendingLook && state.oemEnabled && freshSpeed() && state.modules.length) {
                            state.pendingLook = false;
                            reapplyLook('LAST AMBIENT LOOK RESTORED');
                        }
                        if (!state.oemEnabled && state.modules.length && !state.blackoutOverride && !state.blackoutApplying
                            && Date.now() - state.blackoutLastAttemptAt > 10000 && freshSpeed()) {
                            applyBlackoutOverride();
                        }
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
            if (state.activeCustom || state.blackoutOverride) await restoreBmw();
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
            } finally {
                state.scanBusy = false; queueRender();
                if (!state.oemEnabled && state.modules.length && !state.blackoutOverride) {
                    setTimeout(() => applyBlackoutOverride(), 0);
                } else if (state.oemWantApply && state.modules.length) setTimeout(() => applyOemSelection(), 0);
            }
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
        async function applyCustom(isRenewal, requestedColour, requestedZones, allowWhileMoving) {
            if (stopped || state.applyBusy || state.scanBusy || state.busy) return;
            const renewingBlackout = isRenewal && state.blackoutOverride;
            if (!renewingBlackout && !allowWhileMoving && !canChangeColor()) {
                if (isRenewal) {
                    state.activeCustom = false; state.customUpper = null; state.customLower = null; state.customOther = null; state.renewTimer = null;
                    setNotice('CUSTOM COLOUR WILL RETURN TO BMW WHEN ITS SHORT HOLD EXPIRES', C.amber);
                }
                return;
            }
            if (!state.modules.length) {
                if (!isRenewal) setNotice('NO DISCOVERED RGB MODULES · BMW FACTORY LIGHTING IS UNCHANGED', C.amber);
                return;
            }
            const chosen = isRenewal ? [] : (requestedZones || (state.zone === 'all' ? ['upper', 'lower', 'other'] : [state.zone]));
            const healthy = state.modules.filter((m) => !m.fault);
            const applicable = isRenewal ? [] : chosen.filter((zone) => healthy.some((m) => zone === 'other' ? m.part === 'unknown' : m.part === zone));
            if (!isRenewal && !applicable.length) { setNotice('NO HEALTHY LIGHT MODULES FOUND IN THIS ZONE', C.amber); return; }
            const fallback = requestedColour && requestedColour.rgb ? requestedColour : { rgb: rgb(), brightness: brightnessValue() };
            const colorFor = (zone) => {
                const map = requestedColour && requestedColour.byZone;
                const value = map && (map[zone] || map.lower || map.upper);
                return value && value.rgb ? value : fallback;
            };
            if (applicable.indexOf('upper') >= 0) state.customUpper = Object.assign({}, colorFor('upper'));
            if (applicable.indexOf('lower') >= 0) state.customLower = Object.assign({}, colorFor('lower'));
            if (applicable.indexOf('other') >= 0) state.customOther = Object.assign({}, colorFor('other'));
            const looks = activeZoneLooks();
            if (!looks.length) { setNotice('NO HEALTHY MODULES FOUND IN THIS ZONE', C.amber); return; }
            clearTimeout(state.renewTimer); state.renewTimer = null;
            state.applyBusy = true;
            if (!isRenewal) setNotice('APPLYING ' + (state.oemSelected ? state.oemSelected.name : 'COLOUR') + ' TO ' + looks.map((x) => x.modules.length).reduce((a, b) => a + b, 0) + ' MODULES…', C.cyan);
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
                    if (state.blackoutOverride) state.blackoutOverride = false;
                    if (!isRenewal) setNotice('BDC DID NOT ACCEPT THE COLOUR · BMW LIGHTING IS UNCHANGED', C.red);
                }
            } catch (e) {
                state.activeCustom = false; state.customUpper = null; state.customLower = null; state.customOther = null;
                if (state.blackoutOverride) state.blackoutOverride = false;
                if (!isRenewal) setNotice('COLOUR COMMAND FAILED · ' + shortError(e).slice(0, 70), C.red);
                log.warn('ambient write: ' + shortError(e));
            } finally { state.applyBusy = false; queueRender(); }
        }
        async function applyBlackoutOverride() {
            if (state.blackoutApplying || stopped || state.oemEnabled) return false;
            state.blackoutApplying = true;
            state.blackoutLastAttemptAt = Date.now();
            const black = { byZone: {
                upper: { rgb: [0, 0, 0], brightness: 0 },
                lower: { rgb: [0, 0, 0], brightness: 0 },
                other: { rgb: [0, 0, 0], brightness: 0 },
            } };
            try {
                await applyCustom(false, black, ['upper', 'lower', 'other'], true);
                const applied = [state.customUpper, state.customLower, state.customOther].some((c) =>
                    c && c.brightness === 0 && c.rgb && c.rgb.every((n) => n === 0));
                state.blackoutOverride = !!(applied && state.activeCustom);
                queueRender();
                return state.blackoutOverride;
            } finally { state.blackoutApplying = false; }
        }
        async function restoreBmw() {
            if (state.applyBusy || state.scanBusy || state.busy) return;
            clearTimeout(state.renewTimer); state.renewTimer = null; state.activeCustom = false; state.blackoutOverride = false;
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
        function brightnessRequest(value) {
            const request = factoryRequest(state.liveSlot || state.slot, value);
            request.controlMenuAmbientePanoramicRoofInteriorLighting = 'SIGNAL_UNBEFUELLT';
            return request;
        }
        async function setOemLightingEnabled(enabled) {
            const previewOnly = !!ctx.preview && !state.proxy;
            const canBlackoutWithModules = !enabled && state.modules.length && state.diag && state.diag.available;
            if (!state.proxy && !previewOnly && !canBlackoutWithModules) {
                setNotice('BMW AMBIENT LIGHT CONTROL IS NOT AVAILABLE', C.amber); return false;
            }
            if (state.oemToggleBusy) return false;
            state.oemToggleBusy = true;
            const previousEnabled = state.oemEnabled;
            try {
                if (enabled && (state.activeCustom || state.blackoutOverride)) {
                    const canReapplyLook = state.look && (
                        (state.look.type === 'combo' && COMBOS[state.look.index]) ||
                        (state.look.type === 'colour' && PALETTE[state.look.index]) ||
                        (state.look.type === 'oem' && state.oemSelected)
                    );
                    if (canReapplyLook) {
                        clearTimeout(state.renewTimer); state.renewTimer = null;
                        state.activeCustom = false; state.blackoutOverride = false;
                        state.customUpper = null; state.customLower = null; state.customOther = null;
                    } else await restoreBmw();
                } else if (!enabled && state.activeCustom) {
                    // Replace the current custom colour directly with the blackout request.
                    // Do not wait for a serial release of every module before turning the lights off.
                    clearTimeout(state.renewTimer); state.renewTimer = null;
                    state.activeCustom = false; state.blackoutOverride = false;
                    state.customUpper = null; state.customLower = null; state.customOther = null;
                }
                state.oemEnabled = !!enabled;
                state.oemPendingTarget = !!enabled;
                state.oemPendingAt = Date.now();
                saveLook();
                queueRender();

                let bmwAccepted = false;
                let bmwError = null;
                if (state.proxy) {
                    try {
                        await ctx.signals.set(state.proxy, 'ambientLightInteriorColour', brightnessRequest(enabled ? 255 : 0));
                        bmwAccepted = true;
                    } catch (e) { bmwError = e; }
                }
                state.oemEnabled = !!enabled;
                state.oemPendingTarget = bmwAccepted ? !!enabled : (!enabled && canBlackoutWithModules ? false : null);
                state.oemPendingAt = state.oemPendingTarget !== null ? Date.now() : 0;
                let moduleBlackout = false;
                if (!enabled && !previewOnly && state.modules.length && state.diag && state.diag.available) {
                    moduleBlackout = await applyBlackoutOverride();
                }
                if (!previewOnly && !bmwAccepted && !moduleBlackout) {
                    state.oemEnabled = previousEnabled; state.oemPendingTarget = null; state.oemPendingAt = 0;
                    saveLook(); queueRender();
                    throw bmwError || new Error('BMW ambient control is unavailable');
                }
                state.oemPendingTarget = bmwAccepted ? !!enabled : null;
                state.oemPendingAt = bmwAccepted ? Date.now() : 0;
                setNotice(enabled ? (previewOnly ? 'PREVIEW LIGHTING ON' : 'AMBIENT LIGHTING ON') : moduleBlackout
                    ? 'AMBIENT LIGHTING OFF · BMW REQUEST ' + (bmwAccepted ? 'ACCEPTED' : 'UNAVAILABLE') + ' · MODULES HELD DARK'
                    : bmwAccepted ? 'AMBIENT LIGHTING OFF · BMW REQUEST ACCEPTED' : 'PREVIEW LIGHTING OFF',
                bmwAccepted ? C.green : C.amber);
                saveLook();
                queueRender();
                return true;
            } catch (e) {
                setNotice('AMBIENT LIGHT REQUEST FAILED · ' + shortError(e).slice(0, 64), C.red);
                log.warn('ambient on/off: ' + shortError(e));
                return false;
            } finally { state.oemToggleBusy = false; }
        }
        function effectiveOemBrightness(value) {
            return clamp(Math.round(value * (state.oemNight ? 0.45 : 1)), 10, 100);
        }
        async function applyOemSelection() {
            if (!state.oemSelected || stopped) return;
            if (state.scanBusy) { state.oemWantApply = true; setNotice('COLOUR READY · APPLYING WHEN MODULE SCAN FINISHES', C.cyan); return; }
            if (!state.modules.length) {
                if (state.scan === 'not scanned') { state.oemWantApply = true; setNotice('COLOUR READY · WAITING FOR AUTOMATIC MODULE SCAN', C.cyan); return; }
                state.oemWantApply = false;
                setNotice('NO RGB MODULES FOUND · BMW LIGHTING WAS NOT CHANGED', C.amber);
                return;
            }
            if (!state.oemEnabled) {
                const enabled = await setOemLightingEnabled(true);
                if (!enabled) return;
            }
            state.oemWantApply = false;
            const color = {
                byZone: {
                    upper: { rgb: state.oemSelected.rgb, brightness: effectiveOemBrightness(state.oemAccent) },
                    lower: { rgb: state.oemSelected.rgb, brightness: effectiveOemBrightness(state.oemBackground) },
                    other: { rgb: state.oemSelected.rgb, brightness: effectiveOemBrightness(Math.round((state.oemAccent + state.oemBackground) / 2)) },
                },
            };
            await applyCustom(false, color, ['upper', 'lower', 'other']);
        }
        /** Shared apply payloads so a pick, a persisted restore and the OEM lock all write the same look. */
        const comboPayload = (c) => ({ byZone: {
            upper: { rgb: hexToRgbScaled(c.c1), brightness: effectiveOemBrightness(state.oemAccent) },
            lower: { rgb: hexToRgbScaled(c.c2), brightness: effectiveOemBrightness(state.oemBackground) },
            other: { rgb: hexToRgbScaled(c.c2), brightness: effectiveOemBrightness(Math.round((state.oemAccent + state.oemBackground) / 2)) },
        } });
        const colourPayload = (c) => { const rgb = hexToRgbScaled(c.c1); return { byZone: {
            upper: { rgb, brightness: effectiveOemBrightness(state.oemAccent) },
            lower: { rgb, brightness: effectiveOemBrightness(state.oemBackground) },
            other: { rgb, brightness: effectiveOemBrightness(Math.round((state.oemAccent + state.oemBackground) / 2)) },
        } }; };
        async function applyComboLook(c, note) {
            if (!state.oemEnabled) { const on = await setOemLightingEnabled(true); if (!on) return; }
            if (note) setNotice(note, C.cyan);
            await applyCustom(false, comboPayload(c), ['upper', 'lower', 'other']);
        }
        async function applyColourLook(c, note) {
            if (!state.oemEnabled) { const on = await setOemLightingEnabled(true); if (!on) return; }
            if (note) setNotice(note, C.cyan);
            await applyCustom(false, colourPayload(c), ['upper', 'lower', 'other']);
        }
        /** Re-writes the last picked look — used for start-up restore and the OEM-menu override lock. */
        async function reapplyLook(note) {
            const lk = state.look;
            if (!lk) return;
            if (lk.type === 'combo' && COMBOS[lk.index]) return applyComboLook(COMBOS[lk.index], note || ('COMBO ' + COMBOS[lk.index].name.toUpperCase() + ' · REAPPLYING…'));
            if (lk.type === 'colour' && PALETTE[lk.index]) return applyColourLook(PALETTE[lk.index], note || (PALETTE[lk.index].name.toUpperCase() + ' · REAPPLYING…'));
            if (lk.type === 'oem' && state.oemSelected) {
                if (note) setNotice(note, C.cyan);
                return applyOemSelection();
            }
        }
        /** A tap on the open right panel: a combo applies both zones, a colour applies it to all zones. */
        async function pickDetailItem(i) {
            if (state.detail === 'zones') {
                const z = ZONE_ROWS[i]; if (!z) return;
                state.zone = z.zone; saveLook(); queueRender(); return;
            }
            if (state.detail === 'combos') {
                const c = COMBOS[i]; if (!c) return;
                state.selCombo = i; state.previewChoice = 'combo'; state.look = { type: 'combo', index: i }; state.pendingLook = false;
                saveLook(); queueRender();
                await applyComboLook(c, 'COMBO ' + c.name.toUpperCase() + ' · APPLYING BOTH ZONES…');
                return;
            }
            if (state.detail === 'colours' && i === 0) {
                // First Color row is the "Combos" entry → open the separate Combos page
                state.detail = 'combos'; state.detailScroll = 0;
                state.detailFocus = state.selCombo >= 0 ? state.selCombo : 0;
                if (ctx.display) { ctx.display.focusKey = 'tgt:drow' + state.detailFocus; lastFocusKey = ctx.display.focusKey; }
                queueRender(); return;
            }
            const c = PALETTE[i - 1]; if (!c) return;
            state.selColour = i - 1; state.previewChoice = 'colour'; state.look = { type: 'colour', index: i - 1 }; state.pendingLook = false;
            saveLook(); queueRender();
            await applyColourLook(c, 'COLOUR ' + c.name.toUpperCase() + ' · APPLYING TO ALL ZONES…');
        }
        async function applyOemBrightness() {
            if (state.oemSelected) return applyOemSelection();
            const healthy = state.modules.filter((m) => !m.fault);
            if (healthy.length) {
                if (!state.oemEnabled && !await setOemLightingEnabled(true)) return;
                const byZone = {};
                ['upper', 'lower', 'other'].forEach((zone) => {
                    const modules = healthy.filter((m) => zone === 'other' ? m.part === 'unknown' : m.part === zone);
                    const color = average(modules);
                    if (!color) return;
                    const base = zone === 'upper' ? state.oemAccent : zone === 'lower' ? state.oemBackground :
                        Math.round((state.oemAccent + state.oemBackground) / 2);
                    byZone[zone] = { rgb: color, brightness: effectiveOemBrightness(base) };
                });
                return applyCustom(false, { byZone }, ['upper', 'lower', 'other']);
            }
            const averageBrightness = effectiveOemBrightness(Math.round((state.oemBackground + state.oemAccent) / 2));
            if (!canChangeColor()) return;
            if (!state.proxy) { setNotice('BMW AMBIENT LIGHT CONTROL IS NOT AVAILABLE', C.amber); return; }
            try {
                await ctx.signals.set(state.proxy, 'ambientLightInteriorColour', brightnessRequest(Math.round(averageBrightness * 2.54)));
                setNotice('BMW AMBIENT BRIGHTNESS UPDATED', C.green);
            } catch (e) { setNotice('BRIGHTNESS REQUEST FAILED · ' + shortError(e).slice(0, 64), C.red); }
        }
        async function adjustOemBrightness(zone, value) {
            if (zone === 'background') state.oemBackground = clamp(value, 10, 100);
            else state.oemAccent = clamp(value, 10, 100);
            saveLook(); queueRender();
            return applyOemBrightness();
        }
        async function selectOemColor(color) {
            state.oemSelected = color;
            state.oemPaletteOpen = true;
            state.look = { type: 'oem', name: color.name }; state.pendingLook = false;
            saveLook(); queueRender();
            if (!state.oemEnabled && !await setOemLightingEnabled(true)) return;
            if (state.scanBusy) { state.oemWantApply = true; setNotice('COLOUR READY · APPLYING WHEN MODULE SCAN FINISHES', C.cyan); return; }
            await applyOemSelection();
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
        function changeZone() { state.zone = state.zone === 'all' ? 'upper' : state.zone === 'upper' ? 'lower' : 'all'; saveLook(); queueRender(); }
        function setPage(page) { state.page = page; queueRender(); }
        function toggleView() { state.page = state.page === 'studio' ? 'bmw' : 'studio'; queueRender(); }
        const actions = {
            view: toggleView, zone: changeZone,
            studioPage: () => setPage('studio'), bmwPage: () => setPage('bmw'), oemPage: () => setPage('oem'),
            oemColorPanel: () => { state.oemPaletteOpen = !state.oemPaletteOpen; queueRender(); },
            panelColour: () => { state.detail = 'colours'; state.detailScroll = 0; state.detailFocus = state.selColour >= 0 ? state.selColour + 1 : 0; if (ctx.display) { ctx.display.focusKey = 'tgt:drow' + state.detailFocus; lastFocusKey = ctx.display.focusKey; } queueRender(); },
            panelCombos: () => { state.detail = 'combos'; state.detailScroll = 0; state.detailFocus = state.selCombo >= 0 ? state.selCombo : 0; if (ctx.display) { ctx.display.focusKey = 'tgt:drow' + state.detailFocus; lastFocusKey = ctx.display.focusKey; } queueRender(); },
            panelZones: () => { state.detail = 'zones'; state.detailScroll = 0; state.detailFocus = Math.max(0, ZONE_ROWS.findIndex((z) => z.zone === state.zone)); if (ctx.display) { ctx.display.focusKey = 'tgt:drow' + state.detailFocus; lastFocusKey = ctx.display.focusKey; } queueRender(); },
            detailBack: () => {
                const prev = state.detail;
                // Combos lives inside the Color page: back returns to Color, then to the main list
                if (prev === 'combos') {
                    state.detail = 'colours'; state.detailScroll = 0;
                    state.detailFocus = state.selColour >= 0 ? state.selColour + 1 : 0;
                    if (ctx.display) { ctx.display.focusKey = 'tgt:drow' + state.detailFocus; lastFocusKey = ctx.display.focusKey; }
                    queueRender(); return;
                }
                state.detail = null; state.detailScroll = 0; state.detailFocus = -1;
                const returnRow = prev === 'colours' ? 1 : prev === 'zones' ? 2 : 0;
                state.oemFocus = returnRow;
                if (ctx.display) { ctx.display.focusKey = 'tgt:row' + returnRow; lastFocusKey = 'tgt:row' + returnRow; }
                queueRender();
            },
            oemLight: async () => {
                const target = !state.oemEnabled;
                const ok = await setOemLightingEnabled(target);
                // turning the ambient back on restores OUR look, not the OEM colour
                if (ok && target) { if (state.look) await reapplyLook(); else if (state.oemSelected) await applyOemSelection(); }
            },
            oemNight: async () => { state.oemNight = !state.oemNight; saveLook(); queueRender(); await applyOemBrightness(); },
            oemDynamic: () => { state.oemDynamic = !state.oemDynamic; saveLook(); queueRender(); },
            backgroundDown: () => adjustOemBrightness('background', state.oemBackground - 10),
            backgroundUp: () => adjustOemBrightness('background', state.oemBackground + 10),
            accentDown: () => adjustOemBrightness('accent', state.oemAccent - 10),
            accentUp: () => adjustOemBrightness('accent', state.oemAccent + 10),
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
            BTN_STUDIO: 'studioPage', BTN_BMW: 'bmwPage', BTN_OEM: 'oemPage',
        };
        Object.keys(clickBindings).forEach((button) => {
            const key = clickBindings[button];
            ui.onClick(button, () => {
                const now = Date.now(); if (lastAction[key] && now - lastAction[key] < 260) return;
                lastAction[key] = now; return actions[key]();
            });
            if (ctx.hideButton) ctx.hideButton(button);
        });

        /** PERFORMANCE-style slanted chip button: pale para, red edge when primary. */
        function chipBtn(cv, x, y, w, h, label, key, opts) {
            const o = opts || {};
            const col = o.color || Sheet.RED;
            Sheet.para(cv, x, y, w, y + h, 10,
                o.active ? G.withAlpha(col, 0.9) : G.withAlpha('#ffffff', o.primary ? 0.15 : 0.08));
            if (o.primary) Sheet.para(cv, x, y, 5, y + h, 10, col);
            cv.text(label, x + w / 2 + (o.primary ? 2 : 0), y + h / 2 + 5, o.size || 12,
                o.primary || o.active ? '#ffffff' : G.withAlpha('#e8c8ce', 0.8),
                { align: 'center', font: 'bold', spacing: 0.8, literal: true });
            hitboxes.push({ x, y, w, h, key });
            if (cv.own && key && actions[key]) cv.target(x - 4, y - 4, w + 8, h + 8, actions[key], key, 10);
        }
        /** Small −/+ chip on the right edge of a ribbon value row. */
        function pmChip(cv, x, y, label, key) {
            Sheet.para(cv, x, y, 56, y + 30, 8, G.withAlpha('#ffffff', 0.10));
            cv.text(label, x + 28, y + 22, 17, '#ffffff', { align: 'center', font: 'bold' });
            hitboxes.push({ x, y, w: 56, h: 30, key });
            if (cv.own && actions[key]) cv.target(x - 4, y - 4, 64, 38, actions[key], key, 10);
        }
        function modulesText() {
            return state.scanBusy ? 'SCANNING MODULES' :
                state.modules.length ? state.modules.length + ' MODULES READY' : 'NO MODULES — TAP SCAN';
        }
        /** Status + notice at the ribbon foot (same block style as EXHAUST SYSTEM). */
        function ribbonStatus(cv, rib, y0, y1, statusLine) {
            const sy = y1 - 66, sx = rib.xAt(rib.ribX + 12, sy);
            cv.text(statusLine || modulesText(), sx, sy + 14, 13, '#ff8595',
                { font: 'bold', spacing: 0.8, literal: true });
            if (state.notice)
                cv.text(state.notice.slice(0, 36), sx, sy + 38, 10.5,
                    state.noticeColor || G.withAlpha('#e8c8ce', 0.55),
                    { font: 'bold', spacing: 0.6, literal: true });
        }
        function drawWheel(cv, selected) {
            const cx = 484, cy = (G.TOP || 44) + 8 + 200, inner = 86, outer = 139;
            for (let i = 0; i < 72; i++) cv.arc(cx, cy, inner, outer, i * 5, (i + 1) * 5 + 0.7,
                hex(hsvToRgb(i * 5, 1, 1)));
            cv.circle(cx, cy, inner - 9, '#07090D');
            cv.circle(cx, cy, inner - 10, selected);
            cv.text(hex(rgb()), cx, cy + 6, 18, '#FFFFFF', { align: 'center', font: 'bold', spacing: 0.6 });
            const angle = hueValue() - 90, radius = (inner + outer) / 2;
            const px = cx + Math.cos(angle * Math.PI / 180) * radius, py = cy + Math.sin(angle * Math.PI / 180) * radius;
            cv.circle(px, py, 11, '#FFFFFF'); cv.circle(px, py, 7, selected);
            cv.text('TAP RING · HUE + SATURATION', cx, cy + 168, 10, G.withAlpha('#e8c8ce', 0.4),
                { align: 'center', font: 'bold', spacing: 1, literal: true });
            wheelGeom = { cx, cy, inner, outer };
        }
        /** Cabin light-strip preview; upper/lower given as hex or null for unlit. */
        function drawCabin(cv, x, y, w, h, upperC, lowerC) {
            const r = Math.min(30, h * 0.35);
            cv.roundRect(x, y, w, h, r, '#0A0D13');
            cv.strokeRoundRect(x, y, w, h, r, 2, '#596476');
            cv.roundRect(x + w * 0.22, y + h * 0.12, w * 0.56, h * 0.76, h * 0.2, '#121824');
            cv.strokeRoundRect(x + w * 0.22, y + h * 0.12, w * 0.56, h * 0.76, h * 0.2, 1.2, C.edge);
            const bar = Math.max(4, h * 0.07), side = Math.max(5, w * 0.014);
            cv.roundRect(x + w * 0.05, y + h * 0.24, w * 0.90, bar, 3, upperC);
            cv.roundRect(x + w * 0.05, y + h * 0.38, side, h * 0.40, 3, upperC);
            cv.roundRect(x + w * 0.95 - side, y + h * 0.38, side, h * 0.40, 3, upperC);
            cv.roundRect(x + w * 0.11, y + h * 0.70, w * 0.20, bar, 3, lowerC);
            cv.roundRect(x + w * 0.69, y + h * 0.70, w * 0.20, bar, 3, lowerC);
        }
        /** A ribbon row: tick bar + label + value + two-seg bars, tap zone and ± chips. */
        function valueRow(cv, rib, ry, row) {
            const rx = Sheet.ribbonRow(cv, G, rib.xAt, rib.ribX, ry, {
                label: row.label, value: row.value, lit: !!row.lit, color: row.color,
                font: row.font || 21, run: row.key ? actions[row.key] : null, key: row.key });
            if (row.key) hitboxes.push({ x: rx - 18, y: ry - 12, w: 348, h: 74, key: row.key });
            if (row.minus) { pmChip(cv, rx + 228, ry + 4, '-', row.minus); pmChip(cv, rx + 290, ry + 4, '+', row.plus); }
        }
        function drawStudio(cv, t) {
            const y0 = (G.TOP || 44) + 8, y1 = H - 8;
            const sl = Sheet.slab(cv, G, y0, y1), rib = Sheet.ribbon(cv, y0, y1);
            Sheet.titleTag(cv, G, 40, y0 + 24, 232, 46, 'COLOUR STUDIO', 20);
            const dim = G.withAlpha('#e8c8ce', 0.5);
            const col = rgb(), swatch = hex(previewRgb());

            drawWheel(cv, swatch);

            // Active swatch + quick hues down the slab's right side
            const sx = 690;
            cv.text('ACTIVE COLOUR', sx, y0 + 72, 11, dim, { font: 'bold', spacing: 1.2, literal: true });
            cv.roundRect(sx, y0 + 86, 168, 62, 6, swatch);
            cv.strokeRoundRect(sx, y0 + 86, 168, 62, 6, 1.4,
                state.activeCustom ? Sheet.GO : G.withAlpha('#ffffff', 0.18));
            cv.text(hex(col), sx + 84, y0 + 124, 15, '#ffffff', { align: 'center', font: 'bold' });
            cv.text(zoneName() + (state.activeCustom ? ' · LIVE' : ''), sx + 84, y0 + 168, 10,
                state.activeCustom ? Sheet.GO : dim,
                { align: 'center', font: 'bold', spacing: 1, literal: true });
            cv.text('QUICK HUES', sx, y0 + 190, 11, dim, { font: 'bold', spacing: 1.2, literal: true });
            const quick = [0, 28, 52, 115, 175, 205, 240, 280, 325, 0];
            const quickSat = [100, 100, 100, 88, 88, 88, 82, 78, 76, 0];
            quick.forEach((hue, i) => {
                const qx = sx + (i % 5) * 36, qy = y0 + 204 + Math.floor(i / 5) * 38;
                cv.roundRect(qx, qy, 30, 30, 5, hex(hsvToRgb(hue, quickSat[i] / 100, 1)));
                if (Math.abs(hueValue() - hue) < 4 && Math.abs(saturationValue() - quickSat[i]) < 4)
                    cv.strokeRoundRect(qx - 1.5, qy - 1.5, 33, 33, 6, 2, '#ffffff');
                hitboxes.push({ x: qx, y: qy, w: 30, h: 30, key: 'quick', hue, sat: quickSat[i] });
                if (cv.own) cv.target(qx - 3, qy - 3, 36, 36,
                    () => { settings.set('hue', hue); settings.set('saturation', quickSat[i]); queueRender(); },
                    'quick_' + i, 10);
            });

            // Cabin preview strip across the slab foot; status line just above it
            const upper = state.customUpper ? dimmedRgb(state.customUpper)
                : state.upperRead || (state.zone === 'all' || state.zone === 'upper' ? previewRgb() : null);
            const lower = state.customLower ? dimmedRgb(state.customLower)
                : state.lowerRead || (state.zone === 'all' || state.zone === 'lower' ? previewRgb() : null);
            const msg = modulesText() + (state.notice ? '  ·  ' + state.notice.slice(0, 24) : '');
            cv.text(msg, 587, y0 + 394, 10.5,
                state.notice ? (state.noticeColor || dim) : G.withAlpha('#8c94a0', 0.5),
                { align: 'center', font: 'bold', spacing: 0.8, literal: true });
            drawCabin(cv, 344, y0 + 408, 486, 52,
                upper ? hex(upper) : '#384352', lower ? hex(lower) : '#384352');

            // Ribbon: zone + the three channels, then the action chips
            [
                { label: 'ZONE', value: zoneName(), lit: state.zone !== 'all', key: 'zone' },
                { label: 'HUE', value: hueValue() + '°', minus: 'hueMinus', plus: 'huePlus' },
                { label: 'SATURATION', value: saturationValue() + '%', minus: 'satMinus', plus: 'satPlus' },
                { label: 'BRIGHTNESS', value: brightnessValue() + '%', minus: 'brightnessMinus', plus: 'brightnessPlus' },
            ].forEach((row, i) => valueRow(cv, rib, y0 + 30 + i * 70, row));

            const cy0 = y0 + 314, bx = rib.xAt(rib.ribX + 26, cy0);
            chipBtn(cv, bx, cy0, 132, 40, state.scanBusy ? 'SCANNING' : 'SCAN', 'scan');
            chipBtn(cv, bx + 144, cy0, 132, 40, state.applyBusy ? 'SENDING' : 'APPLY', 'apply', { primary: true });
            chipBtn(cv, bx, cy0 + 50, 132, 40, 'BMW ORIG', 'restore');
            chipBtn(cv, bx + 144, cy0 + 50, 132, 40, 'SAVE LOOK', 'favSave', { size: 10 });
            cv.text('FAV ' + (state.favorite + 1) + '/' + FAVOURITES +
                (state.favorites[state.favorite] ? ' · SAVED' : ' · EMPTY'), bx + 2, cy0 + 116, 11,
                G.withAlpha('#e8c8ce', 0.6), { font: 'bold', spacing: 1, literal: true });
            chipBtn(cv, bx + 148, cy0 + 100, 36, 40, '<', 'favPrev');
            chipBtn(cv, bx + 192, cy0 + 100, 72, 40, 'LOAD', 'favLoad', { size: 10 });
            chipBtn(cv, bx + 272, cy0 + 100, 36, 40, '>', 'favNext');
        }
        function drawBmwPage(cv, t) {
            const y0 = (G.TOP || 44) + 8, y1 = H - 8;
            const sl = Sheet.slab(cv, G, y0, y1), rib = Sheet.ribbon(cv, y0, y1);
            Sheet.titleTag(cv, G, 40, y0 + 24, 232, 46, 'BMW PALETTE', 20);
            cv.text('SAME 12 COLOURS AS', 40, y0 + 100, 11, G.withAlpha('#e8c8ce', 0.5),
                { font: 'bold', spacing: 1, literal: true });
            cv.text('THE ORIGINAL CAR MENU', 40, y0 + 118, 11, G.withAlpha('#e8c8ce', 0.5),
                { font: 'bold', spacing: 1, literal: true });

            const cw = 156, ch = 92, gx = 14, gy = 14;
            for (let n = 1; n <= 12; n++) {
                const cx = sl.ix + ((n - 1) % 3) * (cw + gx), cy = y0 + 28 + Math.floor((n - 1) / 3) * (ch + gy);
                const live = n === state.liveSlot, sel = n === state.slot;
                Sheet.para(cv, cx, cy, cw, cy + ch, 8,
                    live ? G.withAlpha(Sheet.RED, 0.16) : G.withAlpha('#ffffff', 0.05));
                if (live || sel) Sheet.para(cv, cx, cy, 5, cy + ch, 8,
                    live ? Sheet.RED : G.withAlpha('#c8ced8', 0.5));
                cv.text('SLOT ' + String(n).padStart(2, '0'), cx + cw / 2 + 2, cy + 38, 17,
                    live ? '#ffffff' : G.withAlpha('#ffffff', sel ? 0.85 : 0.55),
                    { align: 'center', font: 'bold', spacing: 1, literal: true });
                cv.text(live ? '· VEHICLE ·' : sel ? 'SELECTED' : '', cx + cw / 2 + 2, cy + 64, 10,
                    live ? Sheet.RED : G.withAlpha('#8c94a0', 0.6),
                    { align: 'center', font: 'bold', spacing: 1, literal: true });
                hitboxes.push({ x: cx, y: cy, w: cw, h: ch, key: 'slot', slot: n });
                if (cv.own) cv.target(cx - 4, cy - 4, cw + 8, ch + 8,
                    () => { state.slot = n; setFactorySlot(n); }, 'slot_' + n, 10);
            }

            Sheet.ribbonRow(cv, G, rib.xAt, rib.ribX, y0 + 32, {
                label: 'SELECTED SLOT', value: String(state.slot).padStart(2, '0'), lit: true, font: 30 });
            const cy0 = y0 + 148, bx = rib.xAt(rib.ribX + 26, cy0);
            chipBtn(cv, bx, cy0, 132, 40, 'PREV', 'factoryPrev');
            chipBtn(cv, bx + 144, cy0, 132, 40, 'NEXT', 'factoryNext');
            chipBtn(cv, bx, cy0 + 54, 276, 44, 'APPLY SLOT ' + state.slot, 'factoryApply', { primary: true });
            chipBtn(cv, bx, cy0 + 112, 132, 40, 'STUDIO', 'studioPage');
            chipBtn(cv, bx + 144, cy0 + 112, 132, 40, 'OEM', 'oemPage');
            ribbonStatus(cv, rib, y0, y1,
                state.liveSlot ? 'VEHICLE REPORTS SLOT ' + state.liveSlot : 'VEHICLE SLOT UNKNOWN');
        }
        function drawOemPage(cv, t) {
            const y0 = (G.TOP || 44) + 8, y1 = H - 8;
            const sl = Sheet.slab(cv, G, y0, y1), rib = Sheet.ribbon(cv, y0, y1);
            Sheet.titleTag(cv, G, 40, y0 + 24, 232, 46, 'OEM AMBIENCE', 20);
            const sel = state.oemSelected;
            const dim = G.withAlpha('#e8c8ce', 0.5);

            if (state.oemPaletteOpen) {
                cv.text('CHOOSE A COLOUR', sl.ix, y0 + 36, 14, '#ffffff',
                    { font: 'bold', spacing: 1.2, literal: true });
                chipBtn(cv, sl.ix + sl.iw - 110, y0 + 20, 110, 34, 'DONE', 'oemColorPanel', { primary: true, size: 10 });
                OEM_COLORS.forEach((color, i) => {
                    const cx = sl.ix + (i % 6) * 84, cy = y0 + 52 + Math.floor(i / 6) * 54;
                    const live = state.liveSlot === i + 1, picked = sel && sel.name === color.name;
                    cv.roundRect(cx, cy, 78, 48, 5, color.color);
                    cv.text(color.name, cx + 39, cy + 29, 7.5,
                        color.rgb.reduce((a, b) => a + b, 0) / 3 > 145 ? '#10141B' : 'rgba(255,255,255,0.85)',
                        { align: 'center', font: 'bold', spacing: 0.2, literal: true });
                    if (picked) cv.strokeRoundRect(cx - 1.5, cy - 1.5, 81, 51, 6, 2.2, '#ffffff');
                    if (live) cv.strokeRoundRect(cx + 2.5, cy + 2.5, 73, 43, 4, 1.2, Sheet.RED);
                    hitboxes.push({ x: cx, y: cy, w: 78, h: 48, key: 'oemColor', color });
                    if (cv.own) cv.target(cx - 3, cy - 3, 84, 54, () => selectOemColor(color), 'oem_' + i, 10);
                });
                cv.text('THE CAR SHOWS THE PICK WITHIN A SECOND', sl.ix, y1 - 22, 10, dim,
                    { font: 'bold', spacing: 0.8, literal: true });
            } else {
                const cabinC = sel ? sel.color : '#384352';
                drawCabin(cv, sl.ix + 20, y0 + 120, 468, 190, cabinC, cabinC);
                cv.text(sel ? sel.name.toUpperCase() : 'BMW FACTORY COLOUR', sl.ix + 254, y0 + 350, 17,
                    '#ffffff', { align: 'center', font: 'bold', spacing: 1.2, literal: true });
                cv.text(sel ? hex(sel.rgb) + ' · TAP COLOUR FOR PALETTE' : 'TAP THE COLOUR ROW FOR THE PALETTE',
                    sl.ix + 254, y0 + 378, 10, dim, { align: 'center', font: 'bold', spacing: 0.8, literal: true });
                if (!state.modules.length && !state.scanBusy)
                    chipBtn(cv, sl.ix + 180, y0 + 412, 150, 40, 'RETRY SCAN', 'scan');
            }

            [
                { label: 'AMBIENT LIGHTING', value: state.oemEnabled ? 'ON' : 'OFF', lit: state.oemEnabled, key: 'oemLight' },
                { label: 'COLOUR', value: sel ? sel.name.toUpperCase() : 'FACTORY', lit: !!sel,
                    font: sel && sel.name.length > 9 ? 15 : 18, key: 'oemColorPanel' },
                { label: 'BACKGROUND', value: effectiveOemBrightness(state.oemBackground) + '%',
                    minus: 'backgroundDown', plus: 'backgroundUp' },
                { label: 'ACCENT', value: effectiveOemBrightness(state.oemAccent) + '%',
                    minus: 'accentDown', plus: 'accentUp' },
                { label: 'NIGHT MODE', value: state.oemNight ? 'DIMMED' : 'OFF', lit: state.oemNight, key: 'oemNight' },
            ].forEach((row, i) => valueRow(cv, rib, y0 + 30 + i * 70, row));
            ribbonStatus(cv, rib, y0, y1);
        }
        async function render() {
            // Black screen with the blurred G20 ghost behind it; pages stay in the code, undrawn.
            if (stopped || (!ui.isVisible('MAIN') && !ctx.preview)) return;
            hitboxes = [];
            const cv = ctx.canvas(W, H).clear('#000000');
            try {
                BgArt.load();
                const colour = state.oemEnabled && state.previewChoice === 'colour' && state.selColour >= 0 ? PALETTE[state.selColour] : null;
                const combo = state.oemEnabled && state.previewChoice === 'combo' && state.selCombo >= 0 ? COMBOS[state.selCombo] : null;
                BgArt.setColors(combo ? combo.c1 : colour && colour.c1, combo ? combo.c2 : colour && colour.c1, state.oemEnabled);
                BgArt.draw(cv, W, H);
            } catch (e) { log.warn('background art: ' + shortError(e)); }
            let scr = null;
            if (state.detail) {
                // Full page replaces the panel: back arrow returns to INTERIOR LIGHTING
                const det = Sheet.drawDetailPanel(cv, G, {
                    title: 'INTERIOR LIGHTING',
                    items: state.detail === 'combos' ? COMBOS : state.detail === 'zones' ? ZONE_ROWS
                        : [{ name: 'Combos', nav: true }].concat(PALETTE),
                    sel: state.detail === 'combos' ? state.selCombo : state.detail === 'zones' ? ZONE_ROWS.findIndex((z) => z.zone === state.zone)
                        : (state.selColour >= 0 ? state.selColour + 1 : -1),
                    focus: state.detailFocus,
                    image: state.detail === 'zones' ? BgArt.zones() : null,
                    scroll: state.detailScroll, extra: cv.extra || 0,
                });
                state.detailScrollMax = det.scroll.max;
                if (state.detailScroll > det.scroll.max) state.detailScroll = det.scroll.max;
                scr = det.scroll;
                lastDetGeom = { offsets: det.offsets, rowHs: det.rowHs, avail: det.avail };
                if (det.back) hitboxes.push({ x: det.back.x, y: det.back.y, w: det.back.w, h: det.back.h, key: 'detailBack' });
                det.rows.forEach((r) => hitboxes.push({ x: r.x, y: r.y, w: r.w, h: r.h, key: 'detailItem', i: r.i }));
                if (cv.own) {
                    if (det.back) cv.target(det.back.x, det.back.y, det.back.w, det.back.h, actions.detailBack, 'back', 0);
                    (det.targets || det.rows).forEach((r) => cv.target(r.x, r.y, r.w, r.h, () => pickDetailItem(r.i), 'drow' + r.i, 0));
                }
            } else {
                const hud = Sheet.drawInteriorLighting(cv, G, {
                    enabled: state.oemEnabled, color: state.selColour >= 0 ? PALETTE[state.selColour].c1 : (state.oemSelected ? state.oemSelected.color : '#18d8ff'),
                    combo: state.previewChoice === 'combo' && state.selCombo >= 0 ? COMBOS[state.selCombo] : null,
                    brightness: state.oemAccent, bgBrightness: state.oemBackground, night: state.oemNight, dynamic: state.oemDynamic, focus: state.oemFocus,
                    zone: state.zone, zoneColor: state.oemSelected ? state.oemSelected.color : '#18d8ff',
                    zonesImg: BgArt.zones(), scroll: state.oemScroll, extra: cv.extra || 0,
                });
                state.oemScrollMax = hud.scroll.max;
                if (state.oemScroll > state.oemScrollMax) state.oemScroll = state.oemScrollMax;
                scr = hud.scroll;
                lastHudGeom = { offsets: hud.offsets, rowHs: hud.rowHs, avail: hud.box.h - hud.pinH, pinH: hud.pinH };
                hud.rows.forEach((r) => hitboxes.push({ x: r.x, y: r.y, w: r.w, h: r.h, key: 'hudRow', row: r.i, act: r.key }));
                if (cv.own) (hud.targets || hud.rows).forEach((r) => cv.target(r.x, r.y, r.w, r.h,
                    () => { state.oemFocus = r.i; queueRender(); if (r.key && actions[r.key]) return actions[r.key](); }, 'row' + r.i, 0));
                hitboxes.push({ x: hud.bgMinus.x, y: hud.bgMinus.y, w: hud.bgMinus.w, h: hud.bgMinus.h, key: 'bgDown' });
                hitboxes.push({ x: hud.bgPlus.x, y: hud.bgPlus.y, w: hud.bgPlus.w, h: hud.bgPlus.h, key: 'bgUp' });
                hitboxes.push({ x: hud.minus.x, y: hud.minus.y, w: hud.minus.w, h: hud.minus.h, key: 'accentDown' });
                hitboxes.push({ x: hud.plus.x, y: hud.plus.y, w: hud.plus.w, h: hud.plus.h, key: 'accentUp' });
                hitboxes.push({ x: hud.bar.x, y: hud.bar.y, w: hud.bar.w, h: hud.bar.h, key: 'oemBrightness', zone: 'accent' });
            }
            if (scr && scr.max > 0) cv.scroll = { y: scr.y, bar: scr.bar };
            return ui.image('MAIN_GFX', cv);
        }
        function hitTest(x, y) {
            for (let i = hitboxes.length - 1; i >= 0; i--) {
                const b = hitboxes[i]; if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
                if (b.key === 'quick') { settings.set('hue', b.hue); settings.set('saturation', b.sat); queueRender(); return; }
                if (b.key === 'slot') { state.slot = b.slot; return setFactorySlot(b.slot); }
                if (b.key === 'oemColor') return selectOemColor(b.color);
                if (b.key === 'hudRow') { if (b.act && actions[b.act]) return actions[b.act](); return; }
                if (b.key === 'detailItem') return pickDetailItem(b.i);
                if (b.key && actions[b.key]) return actions[b.key]();
            }
            if (state.page === 'studio' && wheelGeom) {
                const dx = x - wheelGeom.cx, dy = y - wheelGeom.cy, r = Math.sqrt(dx * dx + dy * dy);
                if (r >= wheelGeom.inner - 6 && r <= wheelGeom.outer + 9) {
                    let hue = Math.round((Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360);
                    hue = Math.round(hue / 15) * 15 % 360;
                    settings.set('hue', hue);
                    settings.set('saturation',
                        clamp(Math.round(((r - (wheelGeom.inner - 6)) / (wheelGeom.outer + 9 - wheelGeom.inner + 6) * 100) / 10) * 10, 0, 100));
                    queueRender();
                }
            }
        }
        ctx.onTap((x, y) => { try { hitTest(x, y); } catch (e) { setNotice('CONTROL FAILED · ' + shortError(e), C.red); } });
        if (ctx.onScroll) ctx.onScroll((dy) => {
            const useDetail = state.detail && state.detailScrollMax > 0;
            const max = useDetail ? state.detailScrollMax : (state.oemScrollMax || 0);
            if (!max) return false;
            const key = useDetail ? 'detailScroll' : 'oemScroll';
            const y = Math.max(0, Math.min(max, state[key] + dy));
            if (y === state[key]) return false;
            state[key] = y; queueRender(); return true;
        });
        if (ctx.onTab) ctx.onTab((index) => {
            if (index === 0) setPage('studio'); else if (index === 1) setPage('bmw'); else if (index === 2) setPage('oem');
        });
        ctx.onLayout(queueRender);
        ui.onVisible((name, visible) => {
            if (name === 'MAIN' && visible) {
                // entering the app always lands the controller mark on the first row (Ambient lighting)
                state.oemFocus = 0; state.detailFocus = -1;
                if (ctx.display) { ctx.display.focusKey = 'tgt:row0'; lastFocusKey = 'tgt:row0'; }
                render().catch((e) => log.warn('render: ' + shortError(e)));
            }
        });
        if (ctx.loop) ctx.loop('MAIN', 6, render);

        await watchSignals();
        try { state.diag = await new Diag(ctx.signals, log).init(); state.diag.quiet = true; state.diag.busyLog = false; }
        catch (e) { log.warn('TASU setup: ' + shortError(e)); }
        if (ui.isVisible('MAIN')) render().catch((e) => log.warn('first render: ' + shortError(e)));
        autoScanTimer = setTimeout(() => {
            autoScanTimer = null;
            if (stopped) return;
            scanModules().then(() => {
                // The car remembers the last app look: re-apply it once modules are known.
                if (stopped || !state.look || !state.oemEnabled) return;
                if (state.modules.length && freshSpeed()) reapplyLook('LAST AMBIENT LOOK RESTORED');
                else if (state.modules.length) state.pendingLook = true;   // retry when a fresh speed arrives
            }).catch((e) => log.warn('automatic ambient scan: ' + shortError(e)));
        }, 250);
        if (ctx.display) {
            ctx.display.hideTargetMark = true; ctx.display.customBackBtn = true;
            ctx.display.focusKey = 'tgt:row0'; lastFocusKey = 'tgt:row0';
            ctx.display.onBack = () => {
                if (state.detail) { actions.detailBack(); return true; }
                return false;
            };
        }   // our red row IS the mark; no kit "SELECTED" caption
        // The controller walks the kit's targets (cv.target): mirror its focusKey onto the
        // row it is on and paint that row solid red. Touches never set this mark.
        focusPoll = setInterval(() => {
            if (stopped || !ctx.display) return;
            const k = ctx.display.focusKey;
            if (k === lastFocusKey) return;
            lastFocusKey = k;
            const rm = /^tgt:row(\d+)$/.exec(k || '');
            const dm = /^tgt:drow(\d+)$/.exec(k || '');
            const intoView = (g, i, cur) => {
                const lo = Math.max(0, g.offsets[i] + g.rowHs[i] - g.avail), hi = g.offsets[i];
                return Math.max(lo, Math.min(hi, cur));
            };
            if (rm && lastHudGeom && lastHudGeom.offsets[rm[1]] !== undefined) {
                state.oemFocus = +rm[1]; state.oemScroll = intoView(lastHudGeom, +rm[1], state.oemScroll); queueRender();
            } else if (dm && lastDetGeom && lastDetGeom.offsets[dm[1]] !== undefined) {
                state.detailFocus = +dm[1]; state.detailScroll = intoView(lastDetGeom, +dm[1], state.detailScroll); queueRender();
            } else if (k) {
                if (state.oemFocus !== -1 || state.detailFocus !== -1) { state.oemFocus = -1; state.detailFocus = -1; queueRender(); }
            }
        }, 90);
        if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('shutdown', () => {
            stopped = true; clearTimeout(state.renewTimer); clearTimeout(renderTimer); clearTimeout(autoScanTimer);
            clearInterval(focusPoll);
            ctx._moreAmbientWatches.forEach((sub) => { try { if (sub && sub.shutdown) Promise.resolve(sub.shutdown()).catch(() => {}); } catch (e) {} });
            if (state.activeCustom && !state.blackoutOverride && state.diag && state.diag.available) {
                (async () => {
                    for (const m of state.modules) {
                        try { await sendRestore(m.bus, m.nad); } catch (e) { log.warn('shutdown restore: ' + shortError(e)); }
                    }
                })();
            }
        });
    },
});
