'use strict';

/**
 * VClimateStatus: read-only BMW MGU climate monitor.
 *
 * The public SDK kit confirms an A/C status signal, but does not document the
 * driver/passenger setpoint fields. Those values stay unavailable until their
 * exact names, types and units are checked against this car's SOME/IP catalog.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');

const W = 1600, H = 520;
const C = {
    bg: '#090909', card: '#171717', border: '#292929',
    red: '#E02020', darkRed: '#8B1010', white: '#FFFFFF', muted: '#969696',
    green: '#58C98B',
};
const SIGNAL_POLL_MS = 5000;
const SIGNAL_STALE_MS = 15000;

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

function temperatureDisplay(value) {
    if (typeof value === 'number' && isFinite(value)) {
        const text = Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
        return { text, size: 104, font: 'num', color: C.white, unit: true };
    }
    if (typeof value === 'string') {
        const text = value.trim().toUpperCase();
        if (text === 'HI' || text === 'LO') return { text, size: 104, font: 'bold', color: C.white, unit: false };
    }
    return { text: '--', size: 91, font: 'num', color: '#777777', unit: true };
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const live = {
            ac: null, signalError: false, signalAvailable: false,
            seenAc: false, invalidAc: false, stale: false,
        };
        let renderQueued = false, renderTimer = null, staleTimer = null;
        let stopped = false, subscription = null;

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
            const sub = subscription;
            subscription = null;
            if (sub && typeof sub.shutdown === 'function') {
                Promise.resolve().then(() => sub.shutdown()).catch((e) => {
                    log.warn('signal shutdown: ' + (e && e.message || e));
                });
            }
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
            subscription = result;
            if (stopped) {
                subscription = null;
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
                    ac: true,
                };
            }
            return { demo: false, driver: null, passenger: null, ac: live.ac };
        }

        function badge(cv, label, demo) {
            const x = 1394, y = 52, w = 126, h = 42;
            cv.roundRect(x, y, w, h, 8, demo ? C.darkRed : '#202020');
            cv.fillRect(x, y + 8, 4, h - 16, demo ? C.red : C.green);
            cv.text(label, x + w / 2 + 2, y + 27, 18, C.white, { align: 'center', font: 'bold', spacing: 2 });
        }

        function climateCard(cv, x, title, value, demo) {
            const y = 160, w = 700, h = 274;
            cv.roundRect(x, y, w, h, 12, C.card);
            cv.fillRect(x, y + 20, 5, h - 40, C.red);
            cv.fillRect(x + 38, y + 58, 44, 4, C.red);
            cv.text(title, x + 38, y + 42, 22, C.white, { font: 'bold', spacing: 3 });
            cv.text('SET TEMPERATURE', x + 38, y + 91, 17, C.muted, { font: 'bold', spacing: 2 });

            const shown = temperatureDisplay(value);
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
            cv.text(demo ? 'LOCAL PREVIEW VALUE' : 'SIGNAL UNAVAILABLE', x + 38, y + 257, 15, demo ? C.red : C.muted, { font: 'bold', spacing: 1.3 });
        }

        async function render() {
            if (stopped) return;
            const s = state();
            const cv = ctx.canvas(W, H).clear(C.bg);

            cv.fillRect(48, 50, 5, 76, C.red);
            cv.text('VKPERFORMANCE', 72, 72, 16, C.red, { font: 'bold', spacing: 2.5 });
            cv.text('VClimateStatus', 72, 112, 31, C.white, { font: 'bold', spacing: 0.4 });
            badge(cv, s.demo ? 'DEMO' : 'LIVE', s.demo);
            cv.fillRect(48, 139, 1472, 1, C.border);

            climateCard(cv, 72, 'DRIVER', s.driver, s.demo);
            climateCard(cv, 828, 'PASSENGER', s.passenger, s.demo);

            cv.fillRect(72, 464, 1456, 1, C.border);
            cv.text('CLIMATE STATUS', 72, 499, 15, C.muted, { font: 'bold', spacing: 1.8 });
            const signalUnavailable = live.signalError || !live.signalAvailable || live.stale || live.invalidAc;
            const acText = s.demo ? 'A/C ON' : signalUnavailable ? 'SIGNAL UNAVAILABLE' :
                !live.seenAc ? 'WAITING FOR DATA' : s.ac === null ? 'SIGNAL UNAVAILABLE' : s.ac ? 'A/C ON' : 'A/C OFF';
            cv.fillRect(267, 483, 5, 16, s.ac === true ? C.red : C.muted);
            cv.text(acText, 286, 499, 17, s.ac === true ? C.white : C.muted, { font: 'bold', spacing: 1.1 });
            const sourceText = s.demo ? 'DEMO VALUES · NOT VEHICLE DATA' : 'SETPOINT SIGNALS · SIGNAL UNAVAILABLE';
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
