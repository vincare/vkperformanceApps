'use strict';

/**
 * NaviSport: CarPlay map preview, live BMW telemetry and M SOUND MODE.
 * Power is derived from BMW Sport Display percentage/configured max power or
 * torque × RPM. It is an estimate, not a chassis-dyno measurement.
 */
const mgu = require('./kit/mgu');
const Calc = require('./calculations');
const CarImages = require('./car_images');
const { CarPlayCapture, IMAGE_ID: MAP_IMAGE_ID } = require('./carplay_capture');
const { Controller: FlapController } = require('./flap_controller');

const W = 1600, H = 520;
const FRESH_MS = 4500;
const COLORS = {
    bg: '#050609', panel: '#0B0D12', panel2: '#11141B', border: '#30343D',
    red: '#F32635', redGlow: '#65121D', gold: '#F4B83F',
    white: '#F5F6F8', muted: '#A1A6B0', dim: '#69717D',
    green: '#55D69A', blue: '#329BFF'
};

function finite(value) { return typeof value === 'number' && isFinite(value); }
function labelValue(value, decimals) {
    if (!finite(value)) return '0';
    const scale = Math.pow(10, decimals || 0);
    return String(Math.round(value * scale) / scale);
}
function shortError(error) {
    return String(error && error.message || error || 'Unknown error').replace(/[\r\n]+/g, ' ').slice(0, 100);
}
function gearLabel(payload) {
    const raw = payload && payload.statusActualGearDrive;
    const stage = payload && payload.statusActualStageDrive;
    const stages = { 1: 'P', 2: 'R', 3: 'N', 4: 'D', P: 'P', R: 'R', N: 'N', D: 'D' };
    const stageName = stages[stage];
    let gear = null;
    if (finite(raw)) {
        if (raw === 1) return 'R';
        if (raw === 2) return stageName === 'P' ? 'P' : 'N';
        if (raw >= 3 && raw <= 12) gear = raw - 2;
    } else {
        const match = /^G([1-9]|10)$/i.exec(String(raw || ''));
        if (match) gear = Number(match[1]);
    }
    if (stageName && stageName !== 'D') return stageName;
    return gear ? 'D' + gear : (stageName || null);
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const scaling = ctx.spec && ctx.spec.config && ctx.spec.config.scaling || {};
        const state = {
            rpm: null, rpmAt: 0, torque: null, torqueAt: 0, powerPct: null, powerPctAt: 0,
            speed: null, speedAt: 0, gear: null, signalError: false
        };
        const subscriptions = [];
        let renderTimer = null, freshnessTimer = null, renderQueued = false, stopped = false;
        let carVisual = null, carVisualKey = '';
        let valveReady = false, valveBusy = false, mSoundEnabled = false;
        let valveStatus = 'CHECKING DME SUPPORT';
        let valveStatusAt = 0;

        const valveSettings = {
            get(key) {
                if (key === 'arm') return settings.get('valveControl');
                return settings.get(key);
            },
            set(key, value) { return settings.set(key, value); }
        };
        const valveController = new FlapController(Object.assign({}, ctx, { settings: valveSettings }));
        const capture = new CarPlayCapture(ctx.dataDir, () => queueRender());

        function live(value, at, now) {
            return at > 0 && now - at <= FRESH_MS && finite(value);
        }

        function subscribe(iface, handlers) {
            Promise.resolve(ctx.signals.watch(iface, '1', handlers, log)).then((sub) => {
                if (sub) subscriptions.push(sub);
                state.signalError = false;
                queueRender();
            }).catch((error) => {
                state.signalError = true;
                log.warn('NaviSport signal ' + iface + ': ' + shortError(error));
                queueRender();
            });
        }

        subscribe('de.bmw.infotainment.vehicle.CDS', {
            statusEngineSpeed2(payload) {
                const raw = payload && payload.actualValueRPMEngineCrankshaft;
                const value = Calc.rpm(raw, scaling.rpm);
                if (finite(value)) { state.rpm = value; state.rpmAt = Date.now(); queueRender(); }
            }
        });
        subscribe('de.bmw.infotainment.vehicle.Vehicle2', {
            statusCarSpeed2(payload) {
                const raw = payload && payload.speedVehicleCentreOfGravity;
                const value = Calc.scale(raw, scaling.speed);
                if (finite(value) && value >= 0 && value <= 400) {
                    state.speed = value;
                    state.speedAt = Date.now();
                    queueRender();
                }
            }
        });
        subscribe('de.bmw.infrastructure.VehicleInformation', {
            statusGearboxDrive(payload) {
                const value = gearLabel(payload);
                if (value) { state.gear = value; queueRender(); }
            }
        });
        subscribe('de.bmw.infotainment.drivingexcitement.FES', {
            statusActualValueTorque2(payload) {
                const value = Calc.torque(payload && payload.actualValueTorqueCrankshaft, scaling.torque);
                if (finite(value)) { state.torque = value; state.torqueAt = Date.now(); queueRender(); }
            },
            statusVehicleDynamicEngine(payload) {
                const raw = payload && payload.displaySportEnginePower;
                const value = Calc.percentage(raw, scaling.sportPct);
                if (finite(value)) { state.powerPct = value; state.powerPctAt = Date.now(); queueRender(); }
            }
        });

        function valveSummary(view) {
            if (!settings.get('valveControl') || view.simulated) return 'VALVE CONTROL DISARMED';
            if (view.blocked) return String(view.pickReason || 'NO MATCHED DME').toUpperCase();
            if (view.comm !== 'OK') return 'DIAGNOSTIC LINK UNAVAILABLE';
            return 'M SOUND MODE READY';
        }

        function refreshValveState() {
            valveReady = false;
            valveStatus = 'CHECKING DME SUPPORT';
            queueRender();
            Promise.resolve(valveController.refresh()).then((view) => {
                valveReady = true;
                valveStatus = valveSummary(view);
                valveStatusAt = Date.now();
                queueRender();
            }).catch((error) => {
                valveReady = true;
                valveStatus = 'CONTROL UNAVAILABLE · ' + shortError(error).toUpperCase();
                valveStatusAt = Date.now();
                log.warn('NaviSport exhaust check: ' + shortError(error));
                queueRender();
            });
        }

        Promise.resolve(valveController.start()).then((view) => {
            valveReady = true;
            valveStatus = valveSummary(view);
            valveStatusAt = Date.now();
            queueRender();
        }).catch((error) => {
            valveReady = true;
            valveStatus = 'CONTROL UNAVAILABLE · ' + shortError(error).toUpperCase();
            valveStatusAt = Date.now();
            log.warn('NaviSport exhaust startup: ' + shortError(error));
            queueRender();
        });

        async function toggleMSoundMode() {
            if (valveBusy) return;
            if (!settings.get('valveControl')) {
                valveStatus = 'ENABLE VALVE CONTROL IN SETTINGS';
                valveStatusAt = Date.now();
                queueRender();
                return;
            }
            if (!valveReady) {
                valveStatus = 'CHECKING DME SUPPORT';
                queueRender();
                return;
            }
            const view = valveController.view();
            if (view.simulated || view.blocked || view.comm !== 'OK') {
                valveStatus = valveSummary(view);
                valveStatusAt = Date.now();
                queueRender();
                return;
            }

            const mode = mSoundEnabled ? 'OEM' : 'OPEN';
            valveBusy = true;
            valveStatus = mode === 'OPEN' ? 'REQUESTING OPEN VALVES' : 'RETURNING CONTROL TO BMW';
            valveStatusAt = Date.now();
            queueRender();
            try {
                const result = await valveController.setMode(mode);
                if (result && result.accepted === true) {
                    mSoundEnabled = mode === 'OPEN';
                    valveStatus = mode === 'OPEN'
                        ? 'DME ACCEPTED · PHYSICAL POSITION UNVERIFIED'
                        : 'BMW CONTROL REQUEST ACCEPTED';
                } else {
                    const latest = valveController.view();
                    mSoundEnabled = false;
                    valveStatus = String(latest.error || latest.pickReason || 'DME DID NOT ACCEPT REQUEST').toUpperCase();
                }
            } catch (error) {
                mSoundEnabled = false;
                valveStatus = 'REQUEST FAILED · ' + shortError(error).toUpperCase();
            } finally {
                valveBusy = false;
                valveStatusAt = Date.now();
                queueRender();
            }
        }

        function drawMetric(cv, box, title, value, unit, color, note) {
            cv.roundRect(box.x, box.y, box.w, box.h, 9, COLORS.panel2);
            cv.strokeRoundRect(box.x, box.y, box.w, box.h, 9, 1, COLORS.border);
            cv.fillRect(box.x + 1, box.y + 12, 3, box.h - 24, color);
            cv.text(title, box.x + 16, box.y + 23, 12, COLORS.muted, { font: 'bold', spacing: 1.4 });
            const number = String(value);
            const numberSize = 37;
            const numberWidth = cv.textWidth(number, numberSize, { font: 'num' });
            cv.text(number, box.x + 16, box.y + 69, numberSize, color, { font: 'num' });
            cv.text(unit, box.x + 21 + numberWidth, box.y + 68, 15, COLORS.muted, { font: 'bold' });
            cv.text(note, box.x + 16, box.y + box.h - 13, 9, COLORS.dim, { font: 'bold', spacing: 0.7 });
        }

        function drawSoundButton(cv, active, enabled, run) {
            const x = 1002, y = 423, w = 544, h = 52;
            cv.roundRect(x, y, w, h, 8, active ? '#B71928' : '#15171D');
            cv.strokeRoundRect(x, y, w, h, 8, 2, active ? COLORS.red : (enabled ? '#6D737D' : '#393D46'));
            cv.fillRect(x + 1, y + 10, 4, h - 20, active ? '#FFFFFF' : COLORS.red);
            cv.text('M SOUND MODE', x + 19, y + 34, 19, active ? '#FFFFFF' : COLORS.white,
                { font: 'bold', spacing: 1.1, literal: true });
            cv.circle(x + w - 21, y + h / 2, 6, active ? '#FFFFFF' : (enabled ? COLORS.red : '#555A64'));
            if (cv.own) cv.target(x, y, w, h, run, 'navisport_m_sound_mode');
        }

        function drawNavigation(cv, frame) {
            const card = { x: 28, y: 64, w: 930, h: 432 };
            cv.roundRect(card.x, card.y, card.w, card.h, 12, COLORS.panel);
            cv.strokeRoundRect(card.x, card.y, card.w, card.h, 12, 1, COLORS.border);
            cv.fillRect(card.x + 1, card.y + 1, 74, 4, COLORS.red);
            if (frame.state === 'live') {
                cv.image(MAP_IMAGE_ID, 51, 91, 884, 395);
                cv.fillRect(52, 88, 250, 27, [5, 6, 9, 210]);
                cv.text('CARPLAY MAP PREVIEW', 66, 107, 11, COLORS.white, { font: 'bold', spacing: 1.2 });
                return;
            }
            const centerX = card.x + card.w / 2, centerY = card.y + card.h / 2 - 13;
            cv.roundRect(card.x + 34, card.y + 39, card.w - 68, card.h - 76, 8, '#080A0F');
            // Deliberately show no fabricated map when the CarPlay frame is absent.
            cv.circle(centerX, centerY - 43, 31, '#151922');
            cv.circle(centerX, centerY - 43, 19, COLORS.red);
            cv.circle(centerX, centerY - 43, 7, COLORS.white);
            cv.text('CARPLAY NAVIGATION', centerX, centerY + 12, 20, COLORS.white,
                { align: 'center', font: 'bold', spacing: 1.6 });
            cv.text(frame.detail.toUpperCase(), centerX, centerY + 42, 11,
                frame.state === 'unavailable' ? COLORS.gold : COLORS.muted,
                { align: 'center', font: 'bold', spacing: 0.8 });
            cv.text('LIVE MAP APPEARS WHEN THE VEHICLE EXPOSES A CARPLAY FRAME',
                centerX, centerY + 70, 9, COLORS.dim, { align: 'center', font: 'bold', spacing: 0.6 });
        }

        function render() {
            if (stopped || !ui.isVisible('MAIN')) return Promise.resolve();
            const now = Date.now();
            const cv = ctx.canvas(W, H).clear(COLORS.bg);
            const carModel = CarImages.model(settings.get('carModel'));
            if (!carVisual || carVisualKey !== carModel.key) {
                try {
                    carVisual = CarImages.loadSide(carModel.key, COLORS.panel);
                    carVisualKey = carModel.key;
                } catch (error) {
                    carVisual = null;
                    carVisualKey = '';
                    log.warn('NaviSport side view: ' + shortError(error));
                }
            }

            const hasRpm = live(state.rpm, state.rpmAt, now);
            const hasTorque = live(state.torque, state.torqueAt, now);
            const hasPowerPercent = live(state.powerPct, state.powerPctAt, now);
            const torque = hasTorque ? state.torque : null;
            const rpm = hasRpm ? state.rpm : null;
            const maxPowerKw = finite(settings.get('maxPower')) && settings.get('maxPower') > 0
                ? settings.get('maxPower') : 215;
            const powerUnit = settings.get('powerUnit') || 'hp';
            const powerResult = Calc.powerKw(
                hasPowerPercent ? state.powerPct : null,
                torque, rpm,
                settings.get('powerSource') || 'sport',
                maxPowerKw
            );
            const powerValue = powerResult ? Calc.powerValue(powerResult.kw, powerUnit) : null;
            const torqueValue = torque;
            const hasSpeed = live(state.speed, state.speedAt, now);
            const speedText = hasSpeed ? String(Math.round(state.speed)) : '--';
            const frame = capture.snapshot();
            const mSoundReady = valveReady && !valveBusy && settings.get('valveControl') &&
                !valveController.view().simulated && !valveController.view().blocked &&
                valveController.view().comm === 'OK';

            cv.text('NAVISPORT', 34, 37, 22, COLORS.white, { font: 'bold', spacing: 1.7 });
            cv.text('CARPLAY  /  LIVE BMW DATA', 184, 36, 10, COLORS.dim, { font: 'bold', spacing: 1.3 });
            cv.roundRect(1391, 17, 168, 27, 14, frame.state === 'live' ? '#123426' : '#181A21');
            cv.circle(1408, 30, 4, frame.state === 'live' ? COLORS.green : COLORS.dim);
            cv.text(frame.state === 'live' ? 'CARPLAY LINK' : 'MAP SOURCE', 1420, 34, 9,
                frame.state === 'live' ? COLORS.green : COLORS.muted, { font: 'bold', spacing: 0.9 });

            drawNavigation(cv, frame);
            const right = { x: 978, y: 64, w: 594, h: 432 };
            cv.roundRect(right.x, right.y, right.w, right.h, 12, COLORS.panel);
            cv.strokeRoundRect(right.x, right.y, right.w, right.h, 12, 1, COLORS.border);
            cv.fillRect(right.x + 1, right.y + 1, 78, 4, COLORS.red);
            cv.text('DRIVER TELEMETRY', 998, 88, 13, COLORS.muted, { font: 'bold', spacing: 1.5 });

            const powerText = powerValue === null ? '0' : (powerResult.approximate ? '~' : '') + labelValue(powerValue, 0);
            const torqueText = torqueValue === null ? '0' : labelValue(torqueValue, 0);
            const powerNote = !powerResult ? 'WAITING FOR LIVE SIGNAL' :
                powerResult.approximate ? 'TORQUE x RPM · ESTIMATE' : 'BMW SPORT DISPLAY SCALE';
            drawMetric(cv, { x: 994, y: 101, w: 280, h: 111 }, 'HORSE POWER', powerText,
                Calc.powerUnit(powerUnit), COLORS.red, powerNote);
            drawMetric(cv, { x: 1285, y: 101, w: 270, h: 111 }, 'TORQUE', torqueText,
                'Nm', COLORS.gold, hasTorque ? 'BMW LIVE ENGINE SIGNAL' : 'WAITING FOR LIVE SIGNAL');

            cv.fillRect(997, 224, 558, 1, COLORS.border);
            cv.text('VEHICLE SPEED', 999, 247, 10, COLORS.dim, { font: 'bold', spacing: 1 });
            cv.text(speedText, 1096, 247, 17, hasSpeed ? COLORS.white : COLORS.dim, { font: 'num' });
            cv.text('km/h', 1124, 247, 10, COLORS.muted, { font: 'bold' });
            cv.text('GEAR', 1288, 247, 10, COLORS.dim, { font: 'bold', spacing: 1 });
            cv.text(state.gear || '--', 1341, 247, 15, state.gear ? COLORS.white : COLORS.dim, { font: 'bold' });
            cv.text(carModel.label.toUpperCase(), 999, 271, 9, COLORS.dim, { font: 'bold', spacing: 0.9 });
            if (carVisual) cv.image(carVisual.id, 1000, 278, 544, 136);

            drawSoundButton(cv, mSoundEnabled, mSoundReady, toggleMSoundMode);
            let statusText = valveStatus;
            const latest = valveController.view();
            if (!valveBusy && !mSoundEnabled && valveReady && settings.get('valveControl') && latest.blocked) {
                statusText = latest.pickReason || valveStatus;
            }
            cv.text(String(statusText).toUpperCase(), 1000, 492, 9,
                mSoundEnabled ? COLORS.green : (latest.blocked ? COLORS.gold : COLORS.dim),
                { font: 'bold', spacing: 0.45 });
            cv.text(hasPowerPercent || hasTorque ? 'LIVE SIGNALS' : 'WAITING FOR BMW DATA',
                1550, 492, 8, hasPowerPercent || hasTorque ? COLORS.green : COLORS.dim,
                { align: 'right', font: 'bold', spacing: 0.4 });
            return ui.image('MAIN_GFX', cv);
        }

        function queueRender() {
            if (stopped || renderQueued || !ui.isVisible('MAIN')) return;
            renderQueued = true;
            renderTimer = setTimeout(() => {
                renderTimer = null;
                renderQueued = false;
                Promise.resolve(render()).catch((error) => log.warn('NaviSport render: ' + shortError(error)));
            }, 90);
        }

        function cleanup() {
            if (stopped) return;
            stopped = true;
            if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
            if (freshnessTimer) { clearInterval(freshnessTimer); freshnessTimer = null; }
            capture.stop();
            subscriptions.splice(0).forEach((sub) => {
                try { if (sub && typeof sub.shutdown === 'function') Promise.resolve(sub.shutdown()).catch(() => {}); }
                catch (error) { /* no shutdown action needed */ }
            });
        }

        ui.onVisible((name, visible) => {
            if (name !== 'MAIN') return;
            if (visible) {
                capture.start();
                render().catch((error) => log.warn('NaviSport render: ' + shortError(error)));
            } else capture.stop();
        });
        ui.onClick('BTN_M_SOUND', toggleMSoundMode);
        settings.onChange((key) => {
            if (key === 'carModel') { carVisual = null; carVisualKey = ''; }
            if (key === 'valveControl' || key === 'platform') refreshValveState();
            queueRender();
        });
        freshnessTimer = setInterval(queueRender, 1000);
        if (ui.isVisible('MAIN')) {
            capture.start();
            render().catch((error) => log.warn('NaviSport render: ' + shortError(error)));
        }
        ctx.app.on('shutdown', cleanup);
    }
});
