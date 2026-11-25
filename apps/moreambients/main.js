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
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
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
].map(([name, color]) => ({ name, color, rgb: [1, 3, 5].map((i) => Math.min(254, parseInt(color.slice(i, i + 2), 16))) }));
const UPPER_LOC = new Set([0x05, 0x06, 0x09, 0x0a, 0x0c, 0x0d, 0x10, 0x11, 0x13, 0x14, 0x15, 0x16,
    0x17, 0x18, 0x19, 0x1a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x35, 0x36, 0x37,
    0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
    0x47, 0x48, 0x49, 0x4a, 0x62, 0x63, 0x64, 0x65]);
const LOWER_LOC = new Set([0x01, 0x02, 0x03, 0x04, 0x07, 0x08, 0x0b, 0x0e, 0x0f, 0x12, 0x1b, 0x1c,
    0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x33, 0x34, 0x4b, 0x4c]);
// BMW BDC LIN location IDs from the vehicle's own ambient-light map.
const DOOR_LOC = new Set([0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12,
    0x21, 0x22, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x62, 0x63, 0x64, 0x65]);
const FOOTWELL_LOC = new Set([0x01, 0x02, 0x03, 0x04]);
const M_COLOR = {
    dashboard: '#2A64AD', door: '#163A74', footwell: '#D13B2A',
    dashboardRgb: [42, 100, 173], doorRgb: [22, 58, 116], footwellRgb: [209, 59, 42],
};
const MODE_RGB = { comfort: [0, 0, 255], sport: [255, 0, 0], eco: [0, 255, 0] };
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

function hexToRgbBdc(h) {
    // 0xFF is reserved by the BDC protocol as "leave this channel unchanged".
    // Keep every other RGB value exact; pure white is represented by 0xFE.
    return [1, 3, 5].map((i) => Math.min(254, parseInt(h.slice(i, i + 2), 16)));
}
function driveModeOf(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const names = {
        SPORT_DYNAMIC: 'sport', SPORT_EXPERT: 'sport', SPORT_INDIVIDUAL: 'sport', BOOST: 'sport',
        PHEV_SPORT_STANDARD: 'sport', PHEV_SPORT_INDIVIDUAL: 'sport', PHEV_SPORT_PLUS: 'sport',
        COMFORT: 'comfort', COMFORT_PLUS: 'comfort', COMFORT_INDIVIDUAL: 'comfort',
        ECO_PRO_EFFICIENT: 'eco', ECO_PRO_PLUS: 'eco', ECO_PRO_INDIVIDUAL: 'eco',
        PHEV_HYBRID_STANDARD: null, PHEV_HYBRID_ECO: null, PHEV_HYBRID_COMFORT: null,
        PHEV_ELECTRIC_STANDARD: null, PHEV_ELECTRIC_INDIVIDUAL: null,
    };
    const numeric = typeof raw === 'number' || /^\d+$/.test(String(raw)) ? Number(raw) : null;
    if (numeric !== null) {
        if ([1, 2, 3, 15, 16, 23, 28].indexOf(numeric) >= 0) return 'sport';
        if ([4, 5, 6].indexOf(numeric) >= 0) return 'comfort';
        if ([7, 8, 9].indexOf(numeric) >= 0) return 'eco';
        return null;
    }
    const name = String(raw).toUpperCase();
    if (Object.prototype.hasOwnProperty.call(names, name)) return names[name];
    if (/HYBRID|ELECTRIC|ELEKTR/.test(name)) return null;
    return /SPORT|BOOST/.test(name) ? 'sport' : /COMFORT/.test(name) ? 'comfort' : /ECO/.test(name) ? 'eco' : null;
}

/** The Zones page: pick which zone the next colour command targets. */
const ZONE_ROWS = [
    { name: 'DASHBOARD', zone: 'dashboard' },
    { name: 'DOORS', zone: 'doors' },
    { name: 'FOOTWELL', zone: 'footwell' },
];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const state = {
            page: 'studio', zone: 'all', slot: 1, liveSlot: null,
            proxy: null, diag: null, modules: [], scan: 'not scanned',
            busy: false, notice: 'Module scan starts automatically when the app opens.', noticeColor: C.muted,
            scanBusy: false, applyBusy: false, activeCustom: false, renewTimer: null, renewInterval: 0,
            oemBrightnessTimer: null, oemBrightnessPending: false,
            oemPaletteOpen: false, oemSelected: null, oemBackground: 62, oemAccent: 76,
            oemNight: false, oemEnabled: true, oemDynamic: true, oemBrightnessTouched: false, oemFocus: 0, oemWantApply: false,
            oemPendingTarget: null, oemPendingAt: 0, oemToggleBusy: false,
            oemDesiredTarget: null, oemToggleWaiters: [], oemRetryPending: false,
            oemRestoreRequested: false,
            blackoutOverride: false, blackoutApplying: false, blackoutLastAttemptAt: 0,
            oemScroll: 0, oemScrollMax: 0,
            detail: null, detailScroll: 0, detailScrollMax: 0, selColour: -1, selCombo: -1, previewChoice: null,
            detailFocus: -1, look: null, oemLockBusy: false,
            zoneColors: { upper: null, lower: null, dashboard: null, doors: null, footwell: null },
            zoneLightingEnabled: false, zoneColorReturn: null,
            favorites: [], favorite: 0, upperRead: null, lowerRead: null, customUpper: null, customLower: null, customOther: null,
            features: { mColor: false, comfort: false, sport: false, eco: false },
            driveMode: null, activeFeatureLighting: null, modeSyncPending: false, modeSyncBusy: false,
            customByLocation: Object.create(null),
        };
        let stopped = false, renderTimer = null, autoScanTimer = null, renderQueued = false, loopOwnsRenders = false;
        let diagInitPromise = null, bgArtLoaded = false, bgArtLoading = false, bgArtLoadTimer = null;
        let lastAction = Object.create(null), hitboxes = [], wheelGeom = null;
        let lastHudGeom = null, lastDetGeom = null, lastFocusKey = null, focusPoll = null;
        let ambientTouchDown = null, ambientControlTouchDown = null;
        let ccuPrevious = null, ccuWrapper = null;
        let lastOemLockAt = 0;
        const favFile = path.join(ctx.dataDir, 'moreambients_favourites.json');
        const lookFile = path.join(ctx.dataDir, 'moreambients_look.json');
        const hueValue = () => isFiniteNumber(settings.get('hue')) ? settings.get('hue') : 205;
        const saturationValue = () => isFiniteNumber(settings.get('saturation')) ? settings.get('saturation') : 86;
        const brightnessValue = () => isFiniteNumber(settings.get('brightness')) ? settings.get('brightness') : 76;
        const rgb = () => hsvToRgb(hueValue(), saturationValue() / 100, 1);
        const previewRgb = () => hsvToRgb(hueValue(), saturationValue() / 100, brightnessValue() / 100);
        const dimmedRgb = (colour) => colour.rgb.map((n) => Math.round(n * colour.brightness / 100));
        const zoneName = () => state.zone === 'all' ? 'ALL LIGHTS' : state.zone === 'upper' ? 'UPPER / TRIM' : 'LOWER / FOOTWELLS';
        const zoneTargets = () => state.zone === 'all' ? ['upper', 'lower', 'other'] : [state.zone];
        const validHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
        const anyAutoFeature = () => !!(state.features.mColor || state.features.comfort || state.features.sport || state.features.eco);
        function desiredFeatureLighting() {
            if (!state.oemEnabled) return null;
            if (state.features.mColor) return { key: 'mColor', dashboard: M_COLOR.dashboard, door: M_COLOR.door, footwell: M_COLOR.footwell };
            if (state.driveMode && state.features[state.driveMode] && MODE_RGB[state.driveMode]) {
                const c = hex(MODE_RGB[state.driveMode]);
                return { key: state.driveMode, dashboard: c, door: c, footwell: c };
            }
            return null;
        }
        function featurePreviewLighting() {
            const active = desiredFeatureLighting();
            if (active || !state.oemEnabled) return active;
            const mode = ['comfort', 'sport', 'eco'].find((key) => state.features[key]);
            if (!mode) return null;
            const colour = hex(MODE_RGB[mode]);
            return { key: mode, dashboard: colour, door: colour, footwell: colour, armed: true };
        }
        function zonePreviewColors() {
            let dashboard, doors, footwell;
            const feature = desiredFeatureLighting();
            if (feature) {
                dashboard = feature.dashboard; doors = feature.door; footwell = feature.footwell;
                return { upper: dashboard, door: doors, lower: footwell, dashboard, doors, footwell };
            }
            if (state.previewChoice === 'combo' && COMBOS[state.selCombo]) {
                dashboard = doors = COMBOS[state.selCombo].c1; footwell = COMBOS[state.selCombo].c2;
            } else if (state.previewChoice === 'colour' && PALETTE[state.selColour]) {
                dashboard = doors = footwell = PALETTE[state.selColour].c1;
            } else if (state.oemSelected) {
                dashboard = doors = footwell = state.oemSelected.color;
            } else {
                dashboard = doors = footwell = hex(previewRgb());
            }
            if (state.customUpper && state.customUpper.rgb) dashboard = doors = hex(dimmedRgb(state.customUpper));
            if (state.customLower && state.customLower.rgb) footwell = hex(dimmedRgb(state.customLower));
            if (validHex(state.zoneColors.upper)) dashboard = doors = state.zoneColors.upper;
            if (validHex(state.zoneColors.lower)) footwell = state.zoneColors.lower;
            if (validHex(state.zoneColors.dashboard)) dashboard = state.zoneColors.dashboard;
            if (validHex(state.zoneColors.doors)) doors = state.zoneColors.doors;
            if (validHex(state.zoneColors.footwell)) footwell = state.zoneColors.footwell;
            return { upper: dashboard, door: doors, lower: footwell, dashboard, doors, footwell };
        }
        function zoneDetailRows() {
            const colours = zonePreviewColors();
            return [{ name: 'AMBIENT ZONES LIGHTING', desc: state.zoneLightingEnabled ? 'ON · TAP A COLOUR TO EDIT' : 'OFF · TURN ON TO EDIT COLOURS',
                zone: 'toggle', toggle: true, enabled: state.zoneLightingEnabled }].concat(ZONE_ROWS.map((row) => Object.assign({}, row, {
                desc: state.zoneLightingEnabled ? 'Tap the colour to change it' : 'Turn on zone lighting to edit',
                c1: colours[row.zone], disabled: !state.zoneLightingEnabled,
            })));
        }
        function syncZoneColorsForTargets(upper, lower) {
            const targets = zoneTargets();
            if (targets.indexOf('upper') >= 0 && validHex(upper)) {
                state.zoneColors.upper = state.zoneColors.dashboard = state.zoneColors.doors = upper;
            }
            if (targets.indexOf('lower') >= 0 && validHex(lower)) state.zoneColors.lower = state.zoneColors.footwell = lower;
        }
        function setDetailFocus(row) {
            state.detailFocus = row;
            if (ctx.display) { ctx.display.focusKey = 'tgt:drow' + row; lastFocusKey = ctx.display.focusKey; }
        }
        function openZoneColorPicker(zone, row) {
            if (state.detail !== 'zones' || !state.zoneLightingEnabled
                || ['dashboard', 'doors', 'footwell'].indexOf(zone) < 0) return;
            const colors = zonePreviewColors();
            if (!validHex(state.zoneColors.dashboard)) state.zoneColors.dashboard = colors.dashboard;
            if (!validHex(state.zoneColors.doors)) state.zoneColors.doors = colors.doors;
            if (!validHex(state.zoneColors.footwell)) state.zoneColors.footwell = colors.footwell;
            state.zoneColorReturn = { target: zone, row, scroll: state.detailScroll };
            state.detail = 'colours'; state.detailScroll = 0;
            setDetailFocus(1);
            saveLook(); queueRender();
        }
        async function chooseZoneColor(zone, color) {
            if (!state.zoneLightingEnabled || ['dashboard', 'doors', 'footwell'].indexOf(zone) < 0 || !validHex(color)) return;
            const row = ZONE_ROWS.findIndex((r) => r.zone === zone) + 1;
            const origin = state.zoneColorReturn || { target: zone, row, scroll: 0 };
            if (zone === 'dashboard') state.zoneColors.dashboard = state.zoneColors.upper = color;
            else if (zone === 'doors') state.zoneColors.doors = color;
            else state.zoneColors.footwell = state.zoneColors.lower = color;
            disableAutomaticModesForManual(['upper', 'lower', 'other']);
            state.look = { type: 'zone-colours', dashboard: state.zoneColors.dashboard, doors: state.zoneColors.doors,
                footwell: state.zoneColors.footwell, upper: state.zoneColors.dashboard, lower: state.zoneColors.footwell };
            state.detail = 'zones'; state.detailScroll = origin.scroll || 0;
            state.zoneColorReturn = null;
            setDetailFocus(origin.row >= 0 ? origin.row : row);
            saveLook(); queueRender();
            if (!state.oemEnabled && !await setOemLightingEnabled(true)) return;
            await applyZoneLighting(false, 'ZONE COLOUR');
        }
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
                if (saved.oemSelected && saved.oemSelected.name) {
                    // saveLook intentionally stores the palette key, not a duplicate of its RGB data.
                    // Resolve that key against the canonical palette when the app starts again.
                    const match = OEM_COLORS.find((c) => c.name === saved.oemSelected.name);
                    state.oemSelected = match || null;
                }
                state.selColour = isFiniteNumber(saved.selColour) ? saved.selColour : -1;
                state.selCombo = isFiniteNumber(saved.selCombo) ? saved.selCombo : -1;
                state.previewChoice = saved.previewChoice || null;
                if (saved.features && typeof saved.features === 'object') {
                    state.features.mColor = !!saved.features.mColor;
                    state.features.comfort = !!saved.features.comfort;
                    state.features.sport = !!saved.features.sport;
                    state.features.eco = !!saved.features.eco;
                } else if (['mColor', 'comfort', 'sport', 'eco'].indexOf(saved.featureMode) >= 0) {
                    state.features[saved.featureMode] = true;
                }
                if (saved.zoneColors && typeof saved.zoneColors === 'object') {
                    state.zoneColors.upper = validHex(saved.zoneColors.upper) ? saved.zoneColors.upper : null;
                    state.zoneColors.lower = validHex(saved.zoneColors.lower) ? saved.zoneColors.lower : null;
                    state.zoneColors.dashboard = validHex(saved.zoneColors.dashboard) ? saved.zoneColors.dashboard : state.zoneColors.upper;
                    state.zoneColors.doors = validHex(saved.zoneColors.doors) ? saved.zoneColors.doors : state.zoneColors.upper;
                    state.zoneColors.footwell = validHex(saved.zoneColors.footwell) ? saved.zoneColors.footwell : state.zoneColors.lower;
                }
                state.zoneLightingEnabled = typeof saved.zoneLightingEnabled === 'boolean'
                    ? saved.zoneLightingEnabled : !!(state.look && state.look.type === 'zone-colours');
                if (saved.zone === 'all' || saved.zone === 'upper' || saved.zone === 'lower') state.zone = saved.zone;
                if (saved.oemEnabled === false) state.oemEnabled = false;
                if (isFiniteNumber(saved.oemBackground)) state.oemBackground = clamp(saved.oemBackground, 10, 100);
                if (isFiniteNumber(saved.oemAccent)) state.oemAccent = clamp(saved.oemAccent, 10, 100);
                state.oemNight = !!saved.oemNight;
                state.oemDynamic = saved.oemDynamic !== false;
                state.oemBrightnessTouched = !!saved.oemBrightnessTouched;
            }
        } catch (e) { /* first run · keep defaults */ }
        function saveLook() {
            try {
                fs.writeFileSync(lookFile, JSON.stringify({
                    look: state.look, selColour: state.selColour, selCombo: state.selCombo,
                    oemSelected: state.oemSelected && state.oemSelected.name ? { name: state.oemSelected.name } : null,
                    previewChoice: state.previewChoice, zone: state.zone, oemEnabled: state.oemEnabled,
                    features: state.features,
                    zoneColors: state.zoneColors,
                    zoneLightingEnabled: state.zoneLightingEnabled,
                    oemBackground: state.oemBackground, oemAccent: state.oemAccent,
                    oemNight: state.oemNight, oemDynamic: state.oemDynamic, oemBrightnessTouched: state.oemBrightnessTouched,
                }));
            } catch (e) { log.warn('look persist: ' + shortError(e)); }
        }

        function setNotice(text, color) { state.notice = text; state.noticeColor = color || C.muted; queueRender(); }
        function queueRender() {
            // The visible-screen loop already paints the latest state at its 20 FPS cadence.
            // Avoid queuing a second, out-of-band draw for every signal/input update.
            if (stopped || loopOwnsRenders || renderQueued) return;
            renderQueued = true;
            renderTimer = setTimeout(() => {
                renderTimer = null; renderQueued = false;
                Promise.resolve(render()).catch((e) => log.warn('render: ' + shortError(e)));
            }, 55);
        }
        function retryOemToggleWhenIdle() {
            if (!state.oemRetryPending || state.scanBusy || state.applyBusy || state.busy || state.blackoutApplying || stopped) return;
            if (!state.proxy && !(state.modules.length && state.diag && state.diag.available)) return;
            state.oemRetryPending = false;
            setTimeout(() => { if (!stopped) setOemLightingEnabled(state.oemEnabled); }, 0);
        }
        function retryOemBrightnessWhenIdle() {
            if (!state.oemBrightnessPending || state.scanBusy || state.applyBusy || state.busy || state.blackoutApplying || stopped) return;
            state.oemBrightnessPending = false;
            clearTimeout(state.oemBrightnessTimer);
            state.oemBrightnessTimer = setTimeout(() => {
                state.oemBrightnessTimer = null;
                if (stopped) return;
                if (state.scanBusy || state.applyBusy || state.busy || state.blackoutApplying) {
                    state.oemBrightnessPending = true;
                    return;
                }
                Promise.resolve(applyOemBrightness()).catch((e) => log.warn('ambient brightness: ' + shortError(e)));
            }, 90);
        }
        function scheduleOemBrightnessApply() {
            state.oemBrightnessPending = true;
            clearTimeout(state.oemBrightnessTimer);
            state.oemBrightnessTimer = setTimeout(() => {
                state.oemBrightnessTimer = null;
                if (state.scanBusy || state.applyBusy || state.busy || state.blackoutApplying) return;
                state.oemBrightnessPending = false;
                Promise.resolve(applyOemBrightness()).catch((e) => log.warn('ambient brightness: ' + shortError(e)));
            }, 140);
        }
        function scheduleCustomRenewal(delay) {
            const nextDelay = delay == null ? RENEW_MS : delay;
            if (state.renewTimer && state.renewInterval === nextDelay) return;
            clearTimeout(state.renewTimer); state.renewTimer = null;
            if (stopped || !state.activeCustom) return;
            state.renewInterval = nextDelay;
            state.renewTimer = setTimeout(() => {
                state.renewTimer = null;
                state.renewInterval = 0;
                if (stopped || !state.activeCustom) return;
                if (state.applyBusy || state.scanBusy || state.busy || state.blackoutApplying) {
                    scheduleCustomRenewal(700);
                    return;
                }
                applyCustom(true).then((ok) => {
                    if (!ok && state.activeCustom && !state.renewTimer)
                        scheduleCustomRenewal(5000);
                }).catch((e) => {
                    log.warn('ambient renewal: ' + shortError(e));
                    if (state.activeCustom) scheduleCustomRenewal(5000);
                });
            }, nextDelay);
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
                            if (state.activeCustom && !state.blackoutOverride) {
                                // BDC LIN colours can remain on while the factory brightness status reads zero.
                                // Treating that status as an OFF command used to cancel the live look.
                            } else if (state.oemPendingTarget !== null) {
                                // Keep the app's last explicit ON/OFF choice authoritative. The vehicle's
                                // status can lag or keep reporting its previous brightness after a write.
                                const pendingAge = Date.now() - state.oemPendingAt;
                                if (reportedOn === state.oemPendingTarget && pendingAge >= 1000) {
                                    state.oemEnabled = state.oemPendingTarget;
                                    state.oemPendingTarget = null; state.oemPendingAt = 0;
                                } else if (reportedOn !== state.oemPendingTarget && pendingAge >= 12000) {
                                    state.oemEnabled = reportedOn;
                                    state.oemPendingTarget = null; state.oemPendingAt = 0;
                                    setNotice('BMW DID NOT CONFIRM THE AMBIENT LIGHT SETTING', C.amber);
                                } else {
                                    state.oemEnabled = state.oemPendingTarget;
                                }
                            } else if (state.blackoutOverride) state.oemEnabled = false;
                            else {
                                state.oemEnabled = reportedOn;
                            }
                        }
                        if (state.oemEnabled && anyAutoFeature() && state.activeFeatureLighting === null) {
                            setTimeout(() => syncModeLighting().catch((e) => log.warn('drive-mode ambience: ' + shortError(e))), 0);
                        }
                        // OEM menu colour pick (slot changed) while our LIN look is applied
                        // + Ambient lighting ON → overwrite it back. OFF toggle lets OEM through.
                        if (slotChanged && state.oemEnabled && state.activeFeatureLighting && anyAutoFeature() && !state.oemLockBusy
                            && Date.now() - lastOemLockAt > 4000) {
                            lastOemLockAt = Date.now();
                            syncModeLighting(true).catch((e) => log.warn('drive-mode ambience lock: ' + shortError(e)));
                        } else if (slotChanged && state.oemEnabled && state.look && state.activeCustom && !state.activeFeatureLighting && !state.oemLockBusy
                            && Date.now() - lastOemLockAt > 4000) {
                            lastOemLockAt = Date.now(); state.oemLockBusy = true;
                            reapplyLook('OEM MENU CHANGE OVERRIDDEN · APP COLOUR KEPT').finally(() => { state.oemLockBusy = false; });
                        }
                        queueRender();
                    },
                }, log, { pollMs: 5000 });
                if (watch) { state.proxy = watch.proxy || null; if (watch.shutdown) ctx._moreAmbientWatches.push(watch); }
                if (watch && watch.error) log.warn('BMW ambient palette: ' + watch.error);
                retryOemToggleWhenIdle();
                retryOemBrightnessWhenIdle();
            } catch (e) { log.warn('BMW ambient palette signal: ' + shortError(e)); }
            try {
                const watch = await ctx.signals.watch(FES, '1', {
                    statusFESVehicleDynamicSwitchHMI: (v) => {
                        const raw = v && v.actualValueModeDrivingExperience;
                        if (raw === undefined || raw === null || raw === '') return;
                        const nextMode = driveModeOf(raw);
                        if (nextMode === state.driveMode) return;
                        state.driveMode = nextMode;
                        state.modeSyncPending = true;
                        queueRender();
                        syncModeLighting().catch((e) => log.warn('drive-mode ambience: ' + shortError(e)));
                    },
                }, log, { pollMs: 2000 });
                if (watch && watch.shutdown) ctx._moreAmbientWatches.push(watch);
                if (watch && watch.error) log.warn('Driving mode signal: ' + watch.error);
            } catch (e) { log.warn('Driving mode signal: ' + shortError(e)); }
        }
        ctx._moreAmbientWatches = [];

        async function scanModules() {
            if (state.scanBusy || state.applyBusy || state.busy || stopped) return;
            if (state.activeCustom || state.blackoutOverride) await restoreBmw();
            state.scanBusy = true; state.scan = 'scanning'; state.modules = [];
            setNotice('READING THE TWO BMW BODY-CONTROLLER LIGHT BUSES…', C.cyan);
            const found = [];
            try {
                if (!state.diag) {
                    state.diag = new Diag(ctx.signals, log);
                    state.diag.quiet = true; state.diag.busyLog = false;
                    diagInitPromise = state.diag.init();
                }
                if (diagInitPromise) await diagInitPromise;
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
                if (state.oemEnabled && state.oemRestoreRequested && state.modules.length) state.oemRetryPending = true;
                if (state.oemRetryPending) retryOemToggleWhenIdle();
                retryOemBrightnessWhenIdle();
                if (state.zoneLightingEnabled && state.modules.length) {
                    setTimeout(() => applyZoneLighting(true, 'ZONE LIGHTING RESTORED'), 0);
                } else if (state.oemEnabled && anyAutoFeature() && state.modules.length) {
                    setTimeout(() => syncModeLighting().catch((e) => log.warn('drive-mode ambience: ' + shortError(e))), 0);
                } else if (state.oemEnabled && state.oemWantApply && state.modules.length) setTimeout(() => applyOemSelection(), 0);
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
            const grouped = Object.create(null);
            for (const module of state.modules) {
                if (module.fault) continue;
                const byLocation = state.customByLocation[String(module.location)];
                const colour = byLocation || (module.part === 'upper' ? state.customUpper
                    : module.part === 'lower' ? state.customLower : state.customOther);
                if (!colour) continue;
                const key = colour.rgb.join(',') + ':' + colour.brightness;
                if (!grouped[key]) grouped[key] = { zone: 'custom', colour, modules: [] };
                grouped[key].modules.push(module);
            }
            return Object.keys(grouped).map((key) => grouped[key]);
        }
        async function applyCustom(isRenewal, requestedColour, requestedZones, allowWhileMoving, requestedLabel) {
            if (stopped) return false;
            if (state.applyBusy || state.scanBusy || state.busy) {
                if (isRenewal && state.activeCustom) scheduleCustomRenewal(700);
                return false;
            }
            // Ambient colours are safe to change while driving. The former speed gate stopped
            // renewals and let the BDC's temporary LIN override expire while the car was moving.
            if (!state.modules.length) {
                if (isRenewal && state.activeCustom) scheduleCustomRenewal(5000);
                if (!isRenewal) setNotice('NO DISCOVERED RGB MODULES · BMW FACTORY LIGHTING IS UNCHANGED', C.amber);
                return false;
            }
            const chosen = isRenewal ? [] : (requestedZones || (state.zone === 'all' ? ['upper', 'lower', 'other'] : [state.zone]));
            const healthy = state.modules.filter((m) => !m.fault);
            const applicable = isRenewal ? [] : chosen.filter((zone) => healthy.some((m) => zone === 'other' ? m.part === 'unknown' : m.part === zone));
            if (!isRenewal && !applicable.length) { setNotice('NO HEALTHY LIGHT MODULES FOUND IN THIS ZONE', C.amber); return false; }
            const fallback = requestedColour && requestedColour.rgb ? requestedColour : { rgb: rgb(), brightness: brightnessValue() };
            const previousCustom = {
                upper: state.customUpper, lower: state.customLower, other: state.customOther,
                byLocation: Object.assign(Object.create(null), state.customByLocation), active: state.activeCustom,
                feature: state.activeFeatureLighting, blackout: state.blackoutOverride,
            };
            const colorFor = (zone) => {
                const map = requestedColour && requestedColour.byZone;
                const value = map && (map[zone] || map.lower || map.upper);
                return value && value.rgb ? value : fallback;
            };
            if (!isRenewal) {
                if (requestedColour && requestedColour.byLocation) {
                    state.customByLocation = Object.create(null);
                    Object.keys(requestedColour.byLocation).forEach((location) => {
                        const c = requestedColour.byLocation[location];
                        if (c && Array.isArray(c.rgb) && c.rgb.length === 3) {
                            state.customByLocation[String(Number(location))] = { rgb: c.rgb.slice(0, 3), brightness: clamp(Number(c.brightness) || 0, 0, 100) };
                        }
                    });
                } else {
                    healthy.filter((m) => applicable.indexOf(m.part === 'unknown' ? 'other' : m.part) >= 0)
                        .forEach((m) => { delete state.customByLocation[String(m.location)]; });
                }
            }
            if (applicable.indexOf('upper') >= 0) state.customUpper = Object.assign({}, colorFor('upper'));
            if (applicable.indexOf('lower') >= 0) state.customLower = Object.assign({}, colorFor('lower'));
            if (applicable.indexOf('other') >= 0) state.customOther = Object.assign({}, colorFor('other'));
            const looks = activeZoneLooks();
            if (!looks.length) {
                if (isRenewal && state.activeCustom) scheduleCustomRenewal(5000);
                setNotice('NO HEALTHY MODULES FOUND IN THIS ZONE', C.amber); return false;
            }
            clearTimeout(state.renewTimer); state.renewTimer = null;
            state.applyBusy = true;
            if (!isRenewal) setNotice('APPLYING ' + (requestedLabel || (state.oemSelected ? state.oemSelected.name : 'COLOUR')) + ' TO ' + looks.map((x) => x.modules.length).reduce((a, b) => a + b, 0) + ' MODULES…', C.cyan);
            let ok = 0, failed = 0;
            try {
                // Use a bus-wide LIN write when every healthy module on that bus wants the same look.
                // BMW's protocol supports NAD 0 for that case; mixed zone colours still use exact module addresses.
                const healthyByBus = BUSES.map((_, bus) => healthy.filter((m) => m.bus === bus));
                for (const look of looks) {
                    for (let bus = 0; bus < BUSES.length; bus++) {
                        const selected = look.modules.filter((m) => m.bus === bus);
                        if (!selected.length) continue;
                        if (selected.length === healthyByBus[bus].length && selected.length > 1) {
                            const result = await sendFrame(bus, 0, look.colour);
                            if (result.ok) ok += selected.length; else failed += selected.length;
                        } else {
                            for (const m of selected) {
                                const result = await sendFrame(m.bus, m.nad, look.colour);
                                if (result.ok) ok++; else failed++;
                            }
                        }
                    }
                }
                state.activeCustom = !!ok || (isRenewal && state.activeCustom);
                if (ok) {
                    if (!isRenewal) setNotice('COMMAND ACKNOWLEDGED BY ' + ok + ' MODULES' + (failed ? ' · ' + failed + ' NO ACK' : '') + ' · CHECK THE LIGHTS', failed ? C.amber : C.green);
                    scheduleCustomRenewal(failed ? 5000 : RENEW_MS);
                    return true;
                } else {
                    if (!isRenewal) {
                        state.customUpper = previousCustom.upper; state.customLower = previousCustom.lower; state.customOther = previousCustom.other;
                        state.customByLocation = previousCustom.byLocation; state.activeCustom = previousCustom.active;
                        state.activeFeatureLighting = previousCustom.feature; state.blackoutOverride = previousCustom.blackout;
                        if (state.activeCustom) scheduleCustomRenewal(RENEW_MS);
                        setNotice('BDC DID NOT ACCEPT THE COLOUR · PREVIOUS LIGHTING KEPT', C.red);
                    } else if (state.activeCustom) {
                        setNotice('LIGHT LINK TEMPORARILY UNAVAILABLE · RETRYING', C.amber);
                        scheduleCustomRenewal(5000);
                    }
                    return false;
                }
            } catch (e) {
                if (isRenewal) {
                    setNotice('LIGHT LINK TEMPORARILY UNAVAILABLE · RETRYING', C.amber);
                    if (state.activeCustom) scheduleCustomRenewal(5000);
                } else if (ok > 0) {
                    state.activeCustom = true;
                    scheduleCustomRenewal(5000);
                    setNotice('COLOUR PARTLY APPLIED · RETRYING LIGHT MODULES', C.amber);
                } else {
                    state.customUpper = previousCustom.upper; state.customLower = previousCustom.lower; state.customOther = previousCustom.other;
                    state.customByLocation = previousCustom.byLocation; state.activeCustom = previousCustom.active;
                    state.activeFeatureLighting = previousCustom.feature; state.blackoutOverride = previousCustom.blackout;
                    if (state.activeCustom) scheduleCustomRenewal(RENEW_MS);
                    setNotice('COLOUR COMMAND FAILED · ' + shortError(e).slice(0, 70), C.red);
                }
                log.warn('ambient write: ' + shortError(e));
                return false;
            } finally {
                state.applyBusy = false; queueRender();
                retryOemToggleWhenIdle();
                retryOemBrightnessWhenIdle();
                if (state.modeSyncPending && !stopped) setTimeout(() => syncModeLighting().catch((e) => log.warn('drive-mode ambience: ' + shortError(e))), 0);
            }
        }
        async function applyZoneLighting(allowWhileMoving, requestedLabel) {
            if (!state.zoneLightingEnabled) return false;
            if (state.scanBusy || state.scan === 'not scanned') {
                setNotice('ZONE LIGHTING READY · WAITING FOR LIGHT MODULE SCAN', C.cyan);
                return false;
            }
            const preview = zonePreviewColors();
            if (!validHex(state.zoneColors.dashboard)) state.zoneColors.dashboard = preview.dashboard;
            if (!validHex(state.zoneColors.doors)) state.zoneColors.doors = preview.doors;
            if (!validHex(state.zoneColors.footwell)) state.zoneColors.footwell = preview.footwell;
            if (!state.oemEnabled && !await setOemLightingEnabled(true)) return false;

            const brightnessFor = (zone) => effectiveOemBrightness(zone === 'footwell' ? state.oemBackground : state.oemAccent);
            const colourFor = (zone) => ({
                rgb: hexToRgbBdc(state.zoneColors[zone]), brightness: brightnessFor(zone),
            });
            const byZone = { upper: colourFor('dashboard'), lower: colourFor('footwell'), other: colourFor('dashboard') };
            const byLocation = Object.create(null);
            state.modules.filter((m) => !m.fault).forEach((m) => {
                const zone = DOOR_LOC.has(m.location) ? 'doors' : FOOTWELL_LOC.has(m.location) ? 'footwell' : 'dashboard';
                byLocation[String(m.location)] = colourFor(zone);
            });
            const applied = await applyCustom(false, { byZone, byLocation }, ['upper', 'lower', 'other'], !!allowWhileMoving,
                requestedLabel || 'AMBIENT ZONES');
            return applied;
        }
        async function toggleZoneLighting() {
            const enabled = !state.zoneLightingEnabled;
            if (enabled) {
                const preview = zonePreviewColors();
                if (!validHex(state.zoneColors.dashboard)) state.zoneColors.dashboard = preview.dashboard;
                if (!validHex(state.zoneColors.doors)) state.zoneColors.doors = preview.doors;
                if (!validHex(state.zoneColors.footwell)) state.zoneColors.footwell = preview.footwell;
                state.zoneLightingEnabled = true;
                disableAutomaticModesForManual(['upper', 'lower', 'other']);
                state.look = { type: 'zone-colours', dashboard: state.zoneColors.dashboard, doors: state.zoneColors.doors,
                    footwell: state.zoneColors.footwell, upper: state.zoneColors.dashboard, lower: state.zoneColors.footwell };
                saveLook(); queueRender();
                return applyZoneLighting(true, 'AMBIENT ZONES ON');
            }
            state.zoneLightingEnabled = false;
            disableAutomaticModesForManual(['upper', 'lower', 'other']);
            saveLook(); queueRender();
            setNotice('AMBIENT ZONES OFF · SWITCHING LIGHTS OFF', C.cyan);
            return setOemLightingEnabled(false);
        }
        function makeFeaturePayload(feature) {
            const upperBrightness = effectiveOemBrightness(state.oemBrightnessTouched ? state.oemAccent : 100);
            const lowerBrightness = effectiveOemBrightness(state.oemBrightnessTouched ? state.oemBackground : 100);
            if (feature.key !== 'mColor') {
                const c = MODE_RGB[feature.key].slice();
                return { byZone: {
                    upper: { rgb: c, brightness: upperBrightness },
                    lower: { rgb: c, brightness: lowerBrightness },
                    other: { rgb: c, brightness: Math.round((upperBrightness + lowerBrightness) / 2) },
                } };
            }
            const dashboard = { rgb: M_COLOR.dashboardRgb.slice(), brightness: upperBrightness };
            const door = { rgb: M_COLOR.doorRgb.slice(), brightness: upperBrightness };
            const footwell = { rgb: M_COLOR.footwellRgb.slice(), brightness: lowerBrightness };
            const byLocation = Object.create(null);
            state.modules.filter((m) => !m.fault).forEach((m) => {
                byLocation[String(m.location)] = DOOR_LOC.has(m.location) ? door : m.location >= 0x01 && m.location <= 0x04 ? footwell : dashboard;
            });
            return {
                byZone: { upper: dashboard, lower: footwell, other: dashboard },
                byLocation,
            };
        }
        async function syncModeLighting(force) {
            if (stopped) return false;
            if (state.modeSyncBusy) { state.modeSyncPending = true; return false; }
            state.modeSyncBusy = true;
            let result = false;
            try {
                do {
                    state.modeSyncPending = false;
                    if (stopped || !state.oemEnabled) break;
                    if (state.scanBusy || state.applyBusy || state.busy || state.blackoutApplying) {
                        state.modeSyncPending = true;
                        break;
                    }
                    const feature = desiredFeatureLighting();
                    if (feature) {
                        state.oemWantApply = false;
                        if (!force && state.activeFeatureLighting && state.activeFeatureLighting.key === feature.key && state.activeCustom && !state.blackoutOverride) {
                            result = true;
                            continue;
                        }
                        if (!state.modules.length) {
                            state.modeSyncPending = state.scan === 'not scanned' || state.scan === 'scanning';
                            setNotice(state.modeSyncPending ? 'AMBIENT MODE READY · WAITING FOR LIGHT MODULE SCAN' : 'NO RGB MODULES FOUND · MODE COLOUR WAS NOT APPLIED', C.amber);
                            break;
                        }
                        const payload = makeFeaturePayload(feature);
                        result = await applyCustom(false, payload, ['upper', 'lower', 'other'], true,
                            feature.key === 'mColor' ? 'M COLOR · 3 ZONES' : feature.key.toUpperCase() + ' MODE');
                        if (result) {
                            state.activeFeatureLighting = feature;
                            setNotice(feature.key === 'mColor' ? 'M COLOR APPLIED · DASH / DOORS / FOOTWELLS' : feature.key.toUpperCase() + ' MODE COLOUR APPLIED', C.green);
                            queueRender();
                        }
                    } else if (state.activeFeatureLighting) {
                        state.activeFeatureLighting = null;
                        await restoreBmw();
                        result = true;
                    } else if (state.features.comfort || state.features.sport || state.features.eco) {
                        const waitingFor = ['comfort', 'sport', 'eco'].find((mode) => state.features[mode]);
                        if (waitingFor) setNotice(waitingFor.toUpperCase() + ' MODE COLOUR ARMED · WAITING FOR ' + waitingFor.toUpperCase(), C.cyan);
                    }
                } while (state.modeSyncPending && !stopped && state.oemEnabled);
            } finally {
                state.modeSyncBusy = false;
                queueRender();
            }
            return result;
        }
        function disableAutomaticModesForManual(zones) {
            if (!anyAutoFeature() && !state.activeFeatureLighting) return;
            const selected = zones || ['upper', 'lower', 'other'];
            const hasZone = (m) => selected.indexOf(m.part === 'unknown' ? 'other' : m.part) >= 0;
            state.modules.filter(hasZone).forEach((m) => { delete state.customByLocation[String(m.location)]; });
            state.features = { mColor: false, comfort: false, sport: false, eco: false };
            state.activeFeatureLighting = null;
            state.modeSyncPending = false;
            saveLook(); queueRender();
        }
        async function toggleFeatureMode(featureKey) {
            if (['mColor', 'comfort', 'sport', 'eco'].indexOf(featureKey) < 0) return;
            const turningOn = !state.features[featureKey];
            if (featureKey === 'mColor') {
                state.features = { mColor: turningOn, comfort: false, sport: false, eco: false };
            } else state.features = { mColor: false, comfort: false, sport: false, eco: false,
                [featureKey]: turningOn };
            if (turningOn) state.oemWantApply = false;
            state.modeSyncPending = true;
            saveLook(); queueRender();
            if (state.features.mColor) setNotice('M COLOR SELECTED · APPLYING THE 3-ZONE PALETTE', C.cyan);
            else if (turningOn && state.driveMode !== featureKey) {
                setNotice(featureKey.toUpperCase() + ' MODE COLOUR ARMED · WAITING FOR ' + featureKey.toUpperCase(), C.cyan);
            }
            if (turningOn && !state.oemEnabled && !await setOemLightingEnabled(true)) return;
            await syncModeLighting();
        }
        async function applyBlackoutOverride() {
            if (state.blackoutApplying || stopped || state.oemEnabled || state.blackoutOverride) return false;
            state.blackoutApplying = true;
            state.blackoutLastAttemptAt = Date.now();
            state.activeFeatureLighting = null;
            state.customByLocation = Object.create(null);
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
            } finally { state.blackoutApplying = false; retryOemToggleWhenIdle(); retryOemBrightnessWhenIdle(); }
        }
        async function restoreBmw() {
            if (state.applyBusy || state.scanBusy || state.busy) return false;
            clearTimeout(state.renewTimer); state.renewTimer = null; state.activeCustom = false; state.blackoutOverride = false;
            state.activeFeatureLighting = null; state.customByLocation = Object.create(null);
            if (!state.modules.length || !state.diag || !state.diag.available) {
                state.upperRead = null; state.lowerRead = null; state.customUpper = null; state.customLower = null; state.customOther = null;
                setNotice('RESTORE LINK UNAVAILABLE · THE SHORT BMW OVERRIDE WILL EXPIRE BY ITSELF', C.amber);
                return false;
            }
            state.busy = true; setNotice('RESTORING BMW LIGHTING…', C.cyan);
            let ok = 0, failed = 0;
            try {
                for (let bus = 0; bus < BUSES.length; bus++) {
                    const modules = state.modules.filter((m) => m.bus === bus);
                    if (!modules.length) continue;
                    if (modules.length > 1) {
                        if (await sendRestore(bus, 0)) ok += modules.length; else failed += modules.length;
                    } else if (await sendRestore(bus, modules[0].nad)) ok++; else failed++;
                }
                state.upperRead = null; state.lowerRead = null; state.customUpper = null; state.customLower = null; state.customOther = null;
                if (ok > 0 && failed === 0) state.oemRestoreRequested = false;
                setNotice('BMW LIGHTING RESTORED · ' + ok + ' MODULES' + (failed ? ' · ' + failed + ' DID NOT ACK' : ''), failed ? C.amber : C.green);
                return ok > 0 && failed === 0;
            } catch (e) { setNotice('RESTORE FAILED · ' + shortError(e).slice(0, 72), C.red); log.warn('ambient restore: ' + shortError(e)); }
            finally {
                state.busy = false; queueRender(); retryOemToggleWhenIdle();
                retryOemBrightnessWhenIdle();
                if (state.modeSyncPending && !stopped) setTimeout(() => syncModeLighting().catch((e) => log.warn('drive-mode ambience: ' + shortError(e))), 0);
            }
        }
        async function setFactorySlot(n) {
            disableAutomaticModesForManual(zoneTargets());
            if (state.activeCustom) await restoreBmw();
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
        async function sendOemLightingRequest(enabled, previewOnly) {
            const canBlackoutWithModules = !enabled && state.modules.length && state.diag && state.diag.available;
            const hadModuleOverride = state.activeCustom || state.blackoutOverride || state.oemRestoreRequested;
            const canRestoreWithModules = enabled && state.modules.length && state.diag && state.diag.available;
            if (!state.proxy && !previewOnly && !canBlackoutWithModules && !canRestoreWithModules && !state.scanBusy) {
                setNotice('BMW AMBIENT CONTROL UNAVAILABLE · CHECK THE VEHICLE LINK', C.amber);
                return false;
            }
            try {
                if (enabled && hadModuleOverride) {
                    clearTimeout(state.renewTimer); state.renewTimer = null;
                } else if (!enabled && state.activeCustom) {
                    // Replace the current custom colour directly with the blackout request.
                    // Do not wait for a serial release of every module before turning the lights off.
                    clearTimeout(state.renewTimer); state.renewTimer = null;
                    state.activeCustom = false; state.blackoutOverride = false;
                    state.customUpper = null; state.customLower = null; state.customOther = null;
                    state.customByLocation = Object.create(null); state.activeFeatureLighting = null;
                }

                let bmwAccepted = false;
                let bmwError = null;
                if (state.proxy) {
                    try {
                        // 255 means "leave unchanged" in BMW's signal structure; 254 is max ON.
                        await ctx.signals.set(state.proxy, 'ambientLightInteriorColour', brightnessRequest(enabled ? 254 : 0));
                        bmwAccepted = true;
                    } catch (e) { bmwError = e; }
                }
                let moduleBlackout = false;
                let moduleRestore = false;
                if (enabled && !previewOnly && state.modules.length && state.diag && state.diag.available
                    && (hadModuleOverride || !bmwAccepted)) {
                    moduleRestore = await restoreBmw();
                    if (moduleRestore) state.oemRestoreRequested = false;
                } else if (!enabled && !previewOnly && state.modules.length && state.diag && state.diag.available) {
                    moduleBlackout = await applyBlackoutOverride();
                }

                // Keep the latest request if startup discovery or another module operation is still using the link.
                const waitingForWork = (!bmwAccepted && !moduleBlackout && !moduleRestore && !state.proxy && state.scan === 'not scanned')
                    || (!enabled && (state.scanBusy || state.applyBusy || state.busy || state.blackoutApplying))
                    || (enabled && state.oemRestoreRequested && state.scanBusy)
                    || (enabled && hadModuleOverride && (state.applyBusy || state.busy || state.blackoutApplying))
                    || (!bmwAccepted && !moduleBlackout && !moduleRestore
                        && (state.scanBusy || state.applyBusy || state.busy || state.blackoutApplying));
                if (!previewOnly && waitingForWork) {
                    state.oemRetryPending = true;
                    state.oemPendingTarget = !!enabled; state.oemPendingAt = Date.now();
                    setNotice('AMBIENT LIGHT ' + (enabled ? 'ON' : 'OFF') + ' REQUEST QUEUED · FINISHING VEHICLE CONTROL', C.cyan);
                    return true;
                }
                if (!previewOnly && !bmwAccepted && !moduleBlackout && !moduleRestore) {
                    const error = bmwError || new Error('BMW ambient command was not acknowledged');
                    setNotice('AMBIENT LIGHT ' + (enabled ? 'ON' : 'OFF') + ' NOT CONFIRMED · ' + shortError(error).slice(0, 52), C.red);
                    log.warn('ambient on/off: ' + shortError(error));
                    return false;
                }
                if (enabled && !hadModuleOverride && bmwAccepted) state.oemRestoreRequested = false;
                if (state.oemDesiredTarget === null) {
                    state.oemPendingTarget = !!enabled; state.oemPendingAt = Date.now();
                    setNotice(enabled
                        ? (previewOnly ? 'PREVIEW LIGHTING ON' : moduleRestore && !bmwAccepted ? 'AMBIENT LIGHTING ON · MODULES RESTORED' : 'AMBIENT LIGHTING ON · REQUEST SENT')
                        : moduleBlackout && !bmwAccepted ? 'AMBIENT LIGHTING OFF · MODULES HELD DARK' : 'AMBIENT LIGHTING OFF · REQUEST SENT',
                    bmwAccepted ? C.green : C.amber);
                }
                saveLook(); queueRender();
                return true;
            } catch (e) {
                setNotice('AMBIENT LIGHT REQUEST FAILED · ' + shortError(e).slice(0, 64), C.red);
                log.warn('ambient on/off: ' + shortError(e));
                return false;
            }
        }
        async function setOemLightingEnabled(enabled) {
            const target = !!enabled;
            const previewOnly = !!ctx.preview && !state.proxy;
            // Reflect the tap immediately. Additional taps replace the pending target and are not dropped
            // while a previous BMW request is still in flight.
            if (target && !state.oemEnabled) state.oemRestoreRequested = true;
            if (!target) state.oemRestoreRequested = false;
            state.oemEnabled = target;
            state.oemDesiredTarget = target;
            state.oemPendingTarget = target;
            state.oemPendingAt = Date.now();
            saveLook(); queueRender();
            setNotice('AMBIENT LIGHT ' + (target ? 'ON' : 'OFF') + ' · SENDING REQUEST…', C.cyan);
            if (state.oemToggleBusy) return new Promise((resolve) => state.oemToggleWaiters.push(resolve));
            state.oemToggleBusy = true;
            let result = true;
            try {
                while (state.oemDesiredTarget !== null) {
                    const next = state.oemDesiredTarget;
                    state.oemDesiredTarget = null;
                    result = await sendOemLightingRequest(next, previewOnly);
                }
                return result;
            } finally {
                state.oemToggleBusy = false;
                state.oemToggleWaiters.splice(0).forEach((resolve) => resolve(result));
            }
        }
        function effectiveOemBrightness(value) {
            return clamp(Math.round(value * (state.oemNight ? 0.45 : 1)), 10, 100);
        }
        async function applyOemSelection(allowWhileMoving) {
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
            await applyCustom(false, color, zoneTargets(), !!allowWhileMoving);
        }
        /** Shared apply payloads so a pick, a persisted restore and the OEM lock all write the same look. */
        const comboPayload = (c) => ({ byZone: {
            upper: { rgb: hexToRgbBdc(c.c1), brightness: effectiveOemBrightness(state.oemAccent) },
            lower: { rgb: hexToRgbBdc(c.c2), brightness: effectiveOemBrightness(state.oemBackground) },
            other: { rgb: hexToRgbBdc(c.c2), brightness: effectiveOemBrightness(Math.round((state.oemAccent + state.oemBackground) / 2)) },
        } });
        const colourPayload = (c) => { const rgb = hexToRgbBdc(c.c1); return { byZone: {
            upper: { rgb, brightness: effectiveOemBrightness(state.oemAccent) },
            lower: { rgb, brightness: effectiveOemBrightness(state.oemBackground) },
            other: { rgb, brightness: effectiveOemBrightness(Math.round((state.oemAccent + state.oemBackground) / 2)) },
        } }; };
        async function applyComboLook(c, note, allowWhileMoving) {
            if (!state.oemEnabled) { const on = await setOemLightingEnabled(true); if (!on) return; }
            if (note) setNotice(note, C.cyan);
            // A combo is a paired dashboard/footwell look; a previously selected single zone
            // in Zones must not silently restrict it to just one half of the cabin.
            await applyCustom(false, comboPayload(c), ['upper', 'lower', 'other'], !!allowWhileMoving);
        }
        async function applyColourLook(c, note, allowWhileMoving) {
            if (!state.oemEnabled) { const on = await setOemLightingEnabled(true); if (!on) return; }
            if (note) setNotice(note, C.cyan);
            await applyCustom(false, colourPayload(c), zoneTargets(), !!allowWhileMoving);
        }
        async function applyStudioLook(note, allowWhileMoving) {
            const targets = zoneTargets();
            const colour = { rgb: rgb(), brightness: brightnessValue() };
            const colourHex = hex(colour.rgb);
            disableAutomaticModesForManual(targets);
            state.oemSelected = null;
            state.previewChoice = null;
            state.look = {
                type: 'studio', hue: hueValue(), saturation: saturationValue(), brightness: brightnessValue(),
                targets: targets.slice(),
            };
            syncZoneColorsForTargets(colourHex, colourHex);
            saveLook(); queueRender();
            if (!state.oemEnabled && !await setOemLightingEnabled(true)) return false;
            if (note) setNotice(note, C.cyan);
            return applyCustom(false, colour, targets, !!allowWhileMoving, 'CUSTOM COLOUR');
        }
        /** Re-writes the last picked look — used for start-up restore and the OEM-menu override lock. */
        async function reapplyLook(note, allowWhileMoving) {
            const lk = state.look;
            if (!lk) return;
            if (lk.type === 'combo' && COMBOS[lk.index]) return applyComboLook(COMBOS[lk.index], note || ('COMBO ' + COMBOS[lk.index].name.toUpperCase() + ' · REAPPLYING…'), allowWhileMoving);
            if (lk.type === 'colour' && PALETTE[lk.index]) return applyColourLook(PALETTE[lk.index], note || (PALETTE[lk.index].name.toUpperCase() + ' · REAPPLYING…'), allowWhileMoving);
            if (lk.type === 'zone-colours' && state.zoneLightingEnabled) {
                if (!validHex(state.zoneColors.dashboard)) state.zoneColors.dashboard = validHex(lk.dashboard) ? lk.dashboard : lk.upper;
                if (!validHex(state.zoneColors.doors)) state.zoneColors.doors = validHex(lk.doors) ? lk.doors : lk.upper;
                if (!validHex(state.zoneColors.footwell)) state.zoneColors.footwell = validHex(lk.footwell) ? lk.footwell : lk.lower;
                if (!validHex(state.zoneColors.dashboard) || !validHex(state.zoneColors.doors) || !validHex(state.zoneColors.footwell)) return;
                return applyZoneLighting(!!allowWhileMoving, note ? 'ZONE LIGHTING RESTORED' : 'ZONE LIGHTING');
            }
            if (lk.type === 'studio') {
                settings.set('hue', clamp(Number(lk.hue) || 0, 0, 345));
                settings.set('saturation', clamp(Number(lk.saturation) || 0, 0, 100));
                settings.set('brightness', clamp(Number(lk.brightness) || 76, 10, 100));
                const targets = Array.isArray(lk.targets)
                    ? lk.targets.filter((zone) => ['upper', 'lower', 'other'].indexOf(zone) >= 0)
                    : zoneTargets();
                if (!targets.length) return;
                if (state.oemBrightnessTouched) {
                    const selectedRgb = rgb();
                    return applyCustom(false, { byZone: {
                        upper: { rgb: selectedRgb, brightness: effectiveOemBrightness(state.oemAccent) },
                        lower: { rgb: selectedRgb, brightness: effectiveOemBrightness(state.oemBackground) },
                        other: { rgb: selectedRgb, brightness: effectiveOemBrightness(Math.round((state.oemAccent + state.oemBackground) / 2)) },
                    } }, targets, !!allowWhileMoving, note ? 'CUSTOM COLOUR RESTORED' : 'CUSTOM COLOUR');
                }
                return applyCustom(false, { rgb: rgb(), brightness: brightnessValue() }, targets,
                    !!allowWhileMoving, note ? 'CUSTOM COLOUR RESTORED' : 'CUSTOM COLOUR');
            }
            if (lk.type === 'oem' && state.oemSelected) {
                if (note) setNotice(note, C.cyan);
                return applyOemSelection(allowWhileMoving);
            }
        }
        /** A tap on the open right panel: a combo applies both zones, a colour applies it to all zones. */
        async function pickDetailItem(i) {
            if (state.detail === 'zones') {
                if (i === 0) return toggleZoneLighting();
                const z = ZONE_ROWS[i - 1]; if (!z) return;
                if (!state.zoneLightingEnabled) { setNotice('TURN ON AMBIENT ZONES LIGHTING TO EDIT COLOURS', C.amber); return; }
                state.zone = z.zone === 'footwell' ? 'lower' : 'upper';
                saveLook(); setNotice('SELECTED ZONE · ' + z.name, C.cyan); return;
            }
            if (state.detail === 'combos') {
                const c = COMBOS[i]; if (!c) return;
                if (state.zoneColorReturn) {
                    const target = state.zoneColorReturn.target;
                    return chooseZoneColor(target, target === 'footwell' ? c.c2 : c.c1);
                }
                state.zone = 'all';
                disableAutomaticModesForManual(['upper', 'lower', 'other']);
                state.selCombo = i; state.previewChoice = 'combo'; state.look = { type: 'combo', index: i };
                syncZoneColorsForTargets(c.c1, c.c2);
                saveLook(); queueRender();
                await applyComboLook(c, 'COMBO ' + c.name.toUpperCase() + ' · APPLYING TO ' + zoneName() + '…');
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
            if (state.zoneColorReturn) {
                return chooseZoneColor(state.zoneColorReturn.target, c.c1);
            }
            disableAutomaticModesForManual(zoneTargets());
            state.selColour = i - 1; state.previewChoice = 'colour'; state.look = { type: 'colour', index: i - 1 };
            syncZoneColorsForTargets(c.c1, c.c1);
            saveLook(); queueRender();
            await applyColourLook(c, 'COLOUR ' + c.name.toUpperCase() + ' · APPLYING TO ' + zoneName() + '…');
        }
        async function applyOemBrightness() {
            if (state.activeFeatureLighting && anyAutoFeature()) return syncModeLighting(true);
            if (state.zoneLightingEnabled && state.look && state.look.type === 'zone-colours')
                return applyZoneLighting(true, 'ZONE BRIGHTNESS UPDATED');
            if (state.look && state.look.type !== 'oem') return reapplyLook(null, true);
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
                return applyCustom(false, { byZone }, zoneTargets());
            }
            const averageBrightness = effectiveOemBrightness(Math.round((state.oemBackground + state.oemAccent) / 2));
            if (!state.proxy) {
                if (state.scan === 'not scanned' || state.scanBusy) {
                    state.oemBrightnessPending = true;
                    setNotice('BRIGHTNESS CHANGE QUEUED · WAITING FOR THE VEHICLE LINK', C.cyan);
                } else setNotice('BMW AMBIENT LIGHT CONTROL IS NOT AVAILABLE', C.amber);
                return;
            }
            try {
                await ctx.signals.set(state.proxy, 'ambientLightInteriorColour', brightnessRequest(Math.round(averageBrightness * 2.54)));
                setNotice('BMW AMBIENT BRIGHTNESS UPDATED', C.green);
            } catch (e) { setNotice('BRIGHTNESS REQUEST FAILED · ' + shortError(e).slice(0, 64), C.red); }
        }
        async function adjustOemBrightness(zone, value) {
            if (zone === 'background') state.oemBackground = clamp(value, 10, 100);
            else state.oemAccent = clamp(value, 10, 100);
            state.oemBrightnessTouched = true;
            saveLook(); queueRender();
            scheduleOemBrightnessApply();
        }
        async function selectOemColor(color) {
            disableAutomaticModesForManual(zoneTargets());
            state.oemSelected = color;
            state.oemPaletteOpen = true;
            state.look = { type: 'oem', name: color.name };
            syncZoneColorsForTargets(color.color, color.color);
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
            panelColour: () => { state.zoneColorReturn = null; state.detail = 'colours'; state.detailScroll = 0; state.detailFocus = state.selColour >= 0 ? state.selColour + 1 : 0; if (ctx.display) { ctx.display.focusKey = 'tgt:drow' + state.detailFocus; lastFocusKey = ctx.display.focusKey; } queueRender(); },
            panelCombos: () => { state.zoneColorReturn = null; state.detail = 'combos'; state.detailScroll = 0; state.detailFocus = state.selCombo >= 0 ? state.selCombo : 0; if (ctx.display) { ctx.display.focusKey = 'tgt:drow' + state.detailFocus; lastFocusKey = ctx.display.focusKey; } queueRender(); },
            panelZones: () => { state.zoneColorReturn = null; state.detail = 'zones'; state.detailScroll = 0; state.detailFocus = 0; if (ctx.display) { ctx.display.focusKey = 'tgt:drow0'; lastFocusKey = ctx.display.focusKey; } queueRender(); },
            detailBack: () => {
                const prev = state.detail;
                // Combos lives inside the Color page: back returns to Color, then to the main list
                if (prev === 'combos') {
                    state.detail = 'colours'; state.detailScroll = 0;
                    state.detailFocus = state.selColour >= 0 ? state.selColour + 1 : 0;
                    if (ctx.display) { ctx.display.focusKey = 'tgt:drow' + state.detailFocus; lastFocusKey = ctx.display.focusKey; }
                    queueRender(); return;
                }
                if (prev === 'colours' && state.zoneColorReturn) {
                    const origin = state.zoneColorReturn;
                    state.zone = origin.target; state.detail = 'zones'; state.detailScroll = origin.scroll || 0;
                    state.zoneColorReturn = null;
                    setDetailFocus(origin.row);
                    saveLook(); queueRender(); return;
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
                if (ok && target) {
                    if (anyAutoFeature()) await syncModeLighting();
                    else if (state.look) await reapplyLook(); else if (state.oemSelected) await applyOemSelection();
                }
            },
            oemNight: async () => { state.oemNight = !state.oemNight; saveLook(); queueRender(); await applyOemBrightness(); },
            oemDynamic: () => { state.oemDynamic = !state.oemDynamic; saveLook(); queueRender(); },
            mColorMode: () => toggleFeatureMode('mColor'),
            comfortMode: () => toggleFeatureMode('comfort'),
            sportMode: () => toggleFeatureMode('sport'),
            ecoMode: () => toggleFeatureMode('eco'),
            backgroundDown: () => adjustOemBrightness('background', state.oemBackground - 10),
            backgroundUp: () => adjustOemBrightness('background', state.oemBackground + 10),
            accentDown: () => adjustOemBrightness('accent', state.oemAccent - 10),
            accentUp: () => adjustOemBrightness('accent', state.oemAccent + 10),
            hueMinus: () => changeSetting('hue', -15, 0, 345), huePlus: () => changeSetting('hue', 15, 0, 345),
            satMinus: () => changeSetting('saturation', -10, 0, 100), satPlus: () => changeSetting('saturation', 10, 0, 100),
            brightnessMinus: () => changeSetting('brightness', -10, 10, 100), brightnessPlus: () => changeSetting('brightness', 10, 10, 100),
            scan: scanModules,
            apply: () => applyStudioLook('CUSTOM COLOUR · APPLYING TO ' + zoneName() + '…'),
            restore: () => { disableAutomaticModesForManual(); return restoreBmw(); },
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
            // G20 cabin preview behind the controls; auxiliary pages stay in the code, undrawn.
            if (stopped || (!ui.isVisible('MAIN') && !ctx.preview)) return;
            hitboxes = [];
            const cv = ctx.canvas(W, H).clear('#000000');
            const featurePreview = featurePreviewLighting();
            if (!bgArtLoaded && !bgArtLoading) {
                bgArtLoading = true;
                // Let the first interactive frame reach the head unit before decoding and
                // recolouring the large cabin image (the latter is intentionally unchanged).
                bgArtLoadTimer = setTimeout(() => {
                    bgArtLoadTimer = null;
                    try { BgArt.load(); bgArtLoaded = true; }
                    catch (e) { log.warn('background art: ' + shortError(e)); }
                    bgArtLoading = false;
                    queueRender();
                }, 180);
            }
            try {
                if (bgArtLoaded) {
                    const colour = state.oemEnabled && state.previewChoice === 'colour' && state.selColour >= 0 ? PALETTE[state.selColour] : null;
                    const combo = state.oemEnabled && state.previewChoice === 'combo' && state.selCombo >= 0 ? COMBOS[state.selCombo] : null;
                    const pendingUpper = combo ? combo.c1 : colour ? colour.c1 : state.oemSelected ? state.oemSelected.color : hex(previewRgb());
                    const pendingLower = combo ? combo.c2 : colour ? colour.c1 : state.oemSelected ? state.oemSelected.color : hex(previewRgb());
                    const targets = zoneTargets();
                    const upperPreview = targets.indexOf('upper') >= 0 ? pendingUpper
                        : state.customUpper ? hex(dimmedRgb(state.customUpper)) : null;
                    const lowerPreview = targets.indexOf('lower') >= 0 ? pendingLower
                        : state.customLower ? hex(dimmedRgb(state.customLower)) : null;
                    if (featurePreview) {
                        BgArt.setColors(featurePreview.dashboard, featurePreview.footwell, state.oemEnabled, featurePreview.door);
                    } else if (state.detail === 'zones' || state.zoneColorReturn || (state.look && state.look.type === 'zone-colours')) {
                        const zoneColors = zonePreviewColors();
                        BgArt.setColors(zoneColors.upper, zoneColors.lower, state.oemEnabled, zoneColors.door);
                    } else {
                        BgArt.setColors(upperPreview, lowerPreview, state.oemEnabled);
                    }
                    BgArt.draw(cv, W, H);
                }
            } catch (e) { log.warn('background art: ' + shortError(e)); }
            let scr = null;
            if (state.detail) {
                // Full page replaces the panel: back arrow returns to INTERIOR LIGHTING
                const detailItems = state.detail === 'combos' ? COMBOS : state.detail === 'zones' ? zoneDetailRows()
                    : [{ name: 'Combos', nav: true }].concat(PALETTE);
                const zoneHeaderColors = state.detail === 'zones' ? zonePreviewColors() : null;
                let detailSel = state.detail === 'combos' ? state.selCombo : state.detail === 'zones' ? (state.zoneLightingEnabled ? 0 : -1)
                    : (state.selColour >= 0 ? state.selColour + 1 : -1);
                if (state.detail === 'colours' && state.zoneColorReturn) {
                    const selectedColor = zonePreviewColors()[state.zoneColorReturn.target];
                    const selectedPalette = PALETTE.findIndex((color) => color.c1.toLowerCase() === selectedColor.toLowerCase());
                    detailSel = selectedPalette >= 0 ? selectedPalette + 1 : -1;
                }
                const det = Sheet.drawDetailPanel(cv, G, {
                    title: 'INTERIOR LIGHTING',
                    items: detailItems,
                    sel: detailSel,
                    focus: state.detailFocus,
                    imageInfo: state.detail === 'zones' ? { name: zoneName() } : null,
                    imageSwatches: zoneHeaderColors ? [zoneHeaderColors.dashboard, zoneHeaderColors.doors, zoneHeaderColors.footwell] : null,
                    rowH: state.detail === 'zones' ? 72 : undefined,
                    scroll: state.detailScroll, extra: cv.extra || 0,
                });
                state.detailScrollMax = det.scroll.max;
                if (state.detailScroll > det.scroll.max) state.detailScroll = det.scroll.max;
                scr = det.scroll;
                lastDetGeom = { offsets: det.offsets, rowHs: det.rowHs, avail: det.avail };
                if (det.back) hitboxes.push({ x: det.back.x, y: det.back.y, w: det.back.w, h: det.back.h, key: 'detailBack' });
                det.rows.forEach((r) => hitboxes.push({ x: r.x, y: r.y, w: r.w, h: r.h, key: 'detailItem', i: r.i }));
                (det.swatches || []).forEach((s) => hitboxes.push({ x: s.x, y: s.y, w: s.w, h: s.h, key: 'zoneColor', zone: s.zone, row: s.row }));
                if (cv.own) {
                    if (det.back) cv.target(det.back.x, det.back.y, det.back.w, det.back.h, actions.detailBack, 'back', 0);
                    // Touch routing uses the first matching page target. Zone swatches sit inside
                    // their row's full-width target, so register the swatches first or the row
                    // action consumes the tap before openZoneColorPicker() can run.
                    (det.swatches || []).forEach((s) => cv.target(s.x, s.y, s.w, s.h,
                        () => openZoneColorPicker(s.zone, s.row), 'zonecolor_' + s.zone + '_' + s.row, 10));
                    (det.targets || det.rows).forEach((r) => cv.target(r.x, r.y, r.w, r.h, () => pickDetailItem(r.i), 'drow' + r.i, 0));
                }
            } else {
                const zoneLook = state.look && state.look.type === 'zone-colours' ? zonePreviewColors() : null;
                const hud = Sheet.drawInteriorLighting(cv, G, {
                    enabled: state.oemEnabled, color: zoneLook ? (state.zone === 'lower' ? zoneLook.lower : zoneLook.upper)
                        : state.selColour >= 0 ? PALETTE[state.selColour].c1 : (state.oemSelected ? state.oemSelected.color : '#18d8ff'),
                    featureLighting: featurePreview,
                    features: state.features,
                    combo: zoneLook ? { c1: zoneLook.upper, c2: zoneLook.lower }
                        : state.previewChoice === 'combo' && state.selCombo >= 0 ? COMBOS[state.selCombo] : null,
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
                hitboxes.push({ x: hud.bgBar.x, y: hud.bgBar.y, w: hud.bgBar.w, h: hud.bgBar.h, key: 'oemBrightness', zone: 'background' });
                hitboxes.push({ x: hud.accentBar.x, y: hud.accentBar.y, w: hud.accentBar.w, h: hud.accentBar.h, key: 'oemBrightness', zone: 'accent' });
            }
            if (scr && scr.max > 0) cv.scroll = { y: scr.y };
            return ui.image('MAIN_GFX', cv);
        }
        function hitTest(x, y) {
            for (let i = hitboxes.length - 1; i >= 0; i--) {
                const b = hitboxes[i]; if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
                if (b.key === 'quick') { settings.set('hue', b.hue); settings.set('saturation', b.sat); queueRender(); return; }
                if (b.key === 'oemBrightness') {
                    const value = Math.round(10 + clamp((x - b.x) / Math.max(1, b.w), 0, 1) * 90);
                    return adjustOemBrightness(b.zone, value);
                }
                if (b.key === 'slot') { state.slot = b.slot; return setFactorySlot(b.slot); }
                if (b.key === 'oemColor') return selectOemColor(b.color);
                if (b.key === 'hudRow') { if (b.act && actions[b.act]) return actions[b.act](); return; }
                if (b.key === 'zoneColor') return openZoneColorPicker(b.zone, b.row);
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
        // Give the pinned ambient-light row its own touchscreen gesture. The car renderer routes
        // some taps through page targets and others through the page tap handler; taking this row
        // explicitly avoids the switch looking live while its action is missed by either route.
        if (ctx.onTouch) ctx.onTouch((phase, x, y) => {
            if (phase === 1) {
                ambientControlTouchDown = null;
                if (state.page === 'oem' && !state.detail) {
                    const control = hitboxes.slice().reverse().find((b) =>
                        ['bgDown', 'bgUp', 'accentDown', 'accentUp', 'oemBrightness'].indexOf(b.key) >= 0
                        && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
                    if (control) {
                        ambientControlTouchDown = { key: control.key, zone: control.zone, x, y, cancelled: false };
                        if (control.key === 'oemBrightness') hitTest(x, y);
                        return true;
                    }
                }
            }
            if (ambientControlTouchDown) {
                if (phase === 2) {
                    if (ambientControlTouchDown.key === 'oemBrightness') hitTest(x, y);
                    else if (Math.abs(x - ambientControlTouchDown.x) > 16 || Math.abs(y - ambientControlTouchDown.y) > 16)
                        ambientControlTouchDown.cancelled = true;
                }
                if (phase === 3) {
                    const down = ambientControlTouchDown;
                    ambientControlTouchDown = null;
                    if (!down.cancelled) {
                        if (down.key === 'oemBrightness') hitTest(x, y);
                        else hitTest(down.x, down.y);
                    }
                }
                return true;
            }
            let row = null;
            for (let i = hitboxes.length - 1; i >= 0; i--) {
                if (hitboxes[i].key === 'hudRow' && hitboxes[i].row === 0) { row = hitboxes[i]; break; }
            }
            const inRow = !!(row && x >= row.x && x <= row.x + row.w && y >= row.y && y <= row.y + row.h);
            if (phase === 1) {
                if (state.page !== 'oem' || state.detail || !inRow) { ambientTouchDown = null; return false; }
                ambientTouchDown = { x, y, cancelled: false };
                return true;
            }
            if (!ambientTouchDown) return false;
            if (phase === 2 && (Math.abs(x - ambientTouchDown.x) > 16 || Math.abs(y - ambientTouchDown.y) > 16))
                ambientTouchDown.cancelled = true;
            if (phase === 3) {
                const tap = !ambientTouchDown.cancelled && inRow;
                ambientTouchDown = null;
                if (tap) Promise.resolve(actions.oemLight()).catch((e) => setNotice('AMBIENT CONTROL FAILED · ' + shortError(e), C.red));
            }
            return true;
        });
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
        if (ctx.loop) {
            loopOwnsRenders = true;
            if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; renderQueued = false; }
            // 20 FPS on the software path and an explicit 20 FPS cap on the GPU renderer.
            ctx.loop('MAIN', 20, render, { gpuFps: 20 });
        }

        if (ui.isVisible('MAIN')) render().catch((e) => log.warn('first render: ' + shortError(e)));
        // Paint the screen before any vehicle/network setup. Signal subscriptions and diagnostics
        // can take seconds on the head unit, but must not block first app launch.
        state.diag = new Diag(ctx.signals, log);
        state.diag.quiet = true; state.diag.busyLog = false;
        diagInitPromise = state.diag.init().catch((e) => {
            log.warn('TASU setup: ' + shortError(e));
            return state.diag;
        });
        watchSignals().catch((e) => log.warn('BMW signal setup: ' + shortError(e)));
        diagInitPromise.then(() => {
            if (stopped) return;
            retryOemToggleWhenIdle();
            autoScanTimer = setTimeout(() => {
                autoScanTimer = null;
                if (stopped) return;
                scanModules().then(() => {
                    // The car remembers the last app look: re-apply it once modules are known.
                    if (stopped || !state.look || state.zoneLightingEnabled || (!state.oemEnabled && !state.zoneLightingEnabled) || anyAutoFeature()) return;
                    if (state.modules.length) reapplyLook('LAST AMBIENT LOOK RESTORED', !!state.zoneLightingEnabled);
                }).catch((e) => log.warn('automatic ambient scan: ' + shortError(e)));
            }, 250);
        });
        if (ctx.display) {
            ctx.display.hideTargetMark = true; ctx.display.customBackBtn = true;
            ctx.display.focusKey = 'tgt:row0'; lastFocusKey = 'tgt:row0';
            ctx.display.onBack = () => {
                if (state.detail) { actions.detailBack(); return true; }
                return false;
            };
            // In this page the first row is pinned outside the scroll list, so the kit cannot
            // infer that turning the wheel should scroll. Keep that gesture on the page; when
            // either brightness row is focused, wheel and left/right tilt adjust its value.
            ccuPrevious = ctx.display._moreAmbientsCcuBase || ctx.display._ccu;
            ctx.display._moreAmbientsCcuBase = ccuPrevious;
            ccuWrapper = function (v) {
                const k = Number(v.frontRotaryEncoderOperation), pb = Number(v.frontRotaryEncoderPushButton);
                const df = Number(v.frontRotaryEncoderDeflection), previous = this.ccuLast;
                let delta = previous ? ((k - previous.k + 32768) & 0xffff) - 32768 : 0;
                if (Math.abs(delta) > 64) delta = 0;
                const focus = this.focusKey || '';
                const available = state.page === 'oem' && !state.detail && !(pb === 1 || pb === 2);
                if (available && delta && focus === 'tgt:row0') {
                    const next = clamp(state.oemScroll + delta * 70, 0, state.oemScrollMax || 0);
                    if (next !== state.oemScroll) {
                        this.ccuLast = { k, pb, df }; state.oemScroll = next; queueRender(); return;
                    }
                }
                if (available && /^tgt:row[34]$/.test(focus)) {
                    const row = Number(focus.slice(-1)), zone = row === 3 ? 'background' : 'accent';
                    const previousTilt = previous && previous.df;
                    const tiltDelta = (df === 4 || df === 5) && previousTilt !== df ? 5
                        : (df === 10 || df === 11) && previousTilt !== df ? -5 : 0;
                    const change = delta ? delta * 5 : tiltDelta;
                    if (change) {
                        this.ccuLast = { k, pb, df };
                        adjustOemBrightness(zone, (zone === 'background' ? state.oemBackground : state.oemAccent) + change);
                        return;
                    }
                }
                return typeof ccuPrevious === 'function' ? ccuPrevious.call(this, v) : undefined;
            };
            ctx.display._ccu = ccuWrapper;
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
            const zm = /^tgt:zonecolor_(dashboard|doors|footwell)_(\d+)$/.exec(k || '');
            const intoView = (g, i, cur) => {
                const lo = Math.max(0, g.offsets[i] + g.rowHs[i] - g.avail), hi = g.offsets[i];
                return Math.max(lo, Math.min(hi, cur));
            };
            if (rm && lastHudGeom && lastHudGeom.offsets[rm[1]] !== undefined) {
                state.oemFocus = +rm[1]; state.oemScroll = intoView(lastHudGeom, +rm[1], state.oemScroll); queueRender();
            } else if (dm && lastDetGeom && lastDetGeom.offsets[dm[1]] !== undefined) {
                state.detailFocus = +dm[1]; state.detailScroll = intoView(lastDetGeom, +dm[1], state.detailScroll); queueRender();
            } else if (zm && lastDetGeom && lastDetGeom.offsets[zm[2]] !== undefined) {
                state.detailFocus = +zm[2]; state.detailScroll = intoView(lastDetGeom, +zm[2], state.detailScroll); queueRender();
            } else if (k) {
                if (state.oemFocus !== -1 || state.detailFocus !== -1) { state.oemFocus = -1; state.detailFocus = -1; queueRender(); }
            }
        }, 90);
        if (ctx.app && typeof ctx.app.on === 'function') ctx.app.on('shutdown', () => {
            stopped = true; clearTimeout(state.renewTimer); clearTimeout(state.oemBrightnessTimer); clearTimeout(renderTimer); clearTimeout(autoScanTimer); clearTimeout(bgArtLoadTimer);
            if (ctx.display && ccuWrapper && ctx.display._ccu === ccuWrapper) {
                ctx.display._ccu = ccuPrevious;
                delete ctx.display._moreAmbientsCcuBase;
            }
            clearInterval(focusPoll);
            ctx._moreAmbientWatches.forEach((sub) => { try { if (sub && sub.shutdown) Promise.resolve(sub.shutdown()).catch(() => {}); } catch (e) {} });
            if (state.activeCustom && !state.blackoutOverride && state.diag && state.diag.available) {
                (async () => {
                    for (let bus = 0; bus < BUSES.length; bus++) {
                        if (!state.modules.some((m) => m.bus === bus)) continue;
                        try { await sendRestore(bus, 0); } catch (e) { log.warn('shutdown restore: ' + shortError(e)); }
                    }
                })();
            }
        });
    },
});
