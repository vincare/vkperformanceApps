'use strict';
// Pure source mappings and conversions used by PERFORMANCE.
//   node kit/tools/test_performance.js
const Calc = require('../../apps/performance/calculations');
const app = require('../../apps/performance/app.json');

let checks = 0;
function equal(actual, expected, name) {
    checks++;
    if (actual !== expected) throw new Error(name + ': expected ' + expected + ', got ' + actual);
}
function ok(condition, name) {
    checks++;
    if (!condition) throw new Error(name);
}
function close(actual, expected, name) {
    checks++;
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-6) {
        throw new Error(name + ': expected ' + expected + ', got ' + actual);
    }
}

const scaling = {
    rpm: { factor: 0.25, offset: 0, invalid: 65535 },
    torque: { factor: 0.5, offset: -1023.5, invalid: 65535, invalidFrom: 4095 },
    sportPct: { factor: 1, offset: 0, invalid: 255 },
    boost: { factor: 0.01, offset: 0, invalid: 255 },
};

equal(app.id, 'performance', 'app id');
equal(app.version, '0.6.78', 'app version');
equal(app.screens[0].title, '', 'screen title is hidden to avoid repeating Engine Data beside the section tabs');
equal(app.settings.find((setting) => setting.key === 'drivetrainType').default, 'auto', 'drivetrain type defaults to automatic');
const valveControl = app.settings.find((setting) => setting.key === 'valveControl');
equal(valveControl.default, 'on', 'real exhaust control is armed by default');
equal(valveControl.hidden, undefined, 'exhaust arming is visible in Settings');
equal(valveControl.reset, 2, 'saved exhaust arming resets to the safer default once');
equal(app.settings.find((setting) => setting.key === 'maxPower').hidden, undefined, 'power calibration is visible in Settings');
equal(app.settings.find((setting) => setting.key === 'powerSource').hidden, undefined, 'power source is visible in Settings');
equal(app.settings.find((setting) => setting.key === 'demo').default, 'off', 'demo defaults off');
equal(app.settings.find((setting) => setting.key === 'powerGaugeMax').default, 223.7, 'power scale defaults to 300 hp');
equal(app.settings.find((setting) => setting.key === 'torqueGaugeMax').default, 800, 'torque scale default');
ok(app.settings.find((setting) => setting.key === 'powerGaugeMax').steps.some((step) => step === 745.7), 'power scale includes 1000 hp');
ok(app.settings.find((setting) => setting.key === 'torqueGaugeMax').steps.includes(1600), 'torque scale can be raised to 1600 Nm');
app.settings.find((setting) => setting.key === 'powerGaugeMax').steps.forEach((kw) => {
    const maxHp = Calc.powerValue(kw, 'hp'), ticks = Calc.scaleTicks(maxHp, 5);
    close(ticks[ticks.length - 1], maxHp, 'horsepower scale endpoint ' + Math.round(maxHp) + ' hp');
});
app.settings.find((setting) => setting.key === 'torqueGaugeMax').steps.forEach((maxNm) => {
    const ticks = Calc.scaleTicks(maxNm, 5);
    close(ticks[ticks.length - 1], maxNm, 'torque scale endpoint ' + maxNm + ' Nm');
});
equal(app.signals['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2, 'rs', 'DYNO speed signal declared');
equal(app.signals['de.bmw.infotainment.vehicle.CDS2'].statusLongitudinalAccelerationMassCenter, 'rs', 'DYNO acceleration signal declared');
equal(app.signals['de.bmw.infrastructure.analytics.BasicDataSet'].basicDataSet, 'rs', 'optional gearbox BasicDataSet declared for read and subscribe');
equal(app.signals['de.bmw.infotainment.vehicle.TPMS'].statusTyrePressure, 'rs', 'live tire pressure signal declared');
equal(app.signals['de.bmw.infotainment.vehicle.TPMS'].statusTyreTemperature, 'rs', 'live tire temperature signal declared');
equal(app.signals['de.bmw.infotainment.vehicle.TPMS'].statusTargetTyrePressure, 'rs', 'target tire pressure signal declared');
equal(app.signals['de.bmw.infotainment.vehicle.TPMS'].chassisControl, 'w', 'DSC request channel declared writable');
const gearboxScale = app.config.scaling.gearboxTemp;
equal(Calc.scale(96, gearboxScale), 48, 'cluster transmission oil temperature conversion');
equal(Calc.scale(255, gearboxScale), null, 'invalid cluster transmission oil temperature');
equal(app.config.dme.egs.map((candidate) => candidate.did).join(','), '6000', 'only the supported EGS temperature fallback remains configured');
equal(Calc.scale(88, app.config.dme.egs[0]), 48, 'EGS 6000 temperature conversion');
equal(app.config.dme.boost.map((candidate) => candidate.did || 'OBD ' + candidate.obd).join(','),
    'F470,F487,F40B,OBD 0B', 'M Vitals boost candidate order');
equal(app.config.dme.baro.map((candidate) => candidate.did || 'OBD ' + candidate.obd).join(','),
    'F433,OBD 33', 'M Vitals barometer candidate order');

equal(Calc.rpm(4000, scaling.rpm), 1000, 'RPM scale');
equal(Calc.rpm(65535, scaling.rpm), null, 'invalid RPM');
equal(Calc.torque(2200, scaling.torque), 76.5, 'FES torque scale');
equal(Calc.torque(2000, scaling.torque), 0, 'negative engine torque clamp');
equal(Calc.torque(4095, scaling.torque), null, 'invalid torque');
equal(Calc.percentage(87, scaling.sportPct), 87, 'Sport Display percentage');
equal(Calc.percentage(255, scaling.sportPct), null, 'invalid Sport Display percentage');
equal(Calc.percentage(101, scaling.sportPct), null, 'out-of-range Sport Display percentage');

close(Calc.fesBoostBar(100, 'BAR', scaling.boost), 1, 'FES bar conversion');
close(Calc.fesBoostBar(100, 'KPA', scaling.boost), 1, 'FES kPa conversion');
close(Calc.fesBoostBar(100, 'PSI', scaling.boost), 10 / 14.5038, 'FES psi conversion');
equal(Calc.fesBoostBar(255, 'BAR', scaling.boost), null, 'invalid FES boost');
close(Calc.dmeBoostBar(250, 100), 1.5, 'DME gauge boost from absolute kPa');
equal(Calc.dmeBoostBar(250, Infinity), null, 'invalid DME pressure');

const sportPower = Calc.powerKw(50, 300, 3000, 'sport', 215);
close(sportPower.kw, 107.5, 'Sport Display percentage times configured maximum');
equal(sportPower.source, 'BMW SPORT DISPLAY', 'Sport Display power source');
equal(sportPower.approximate, true, 'Sport Display power is labeled as a calibrated estimate');
const calculated = Calc.powerKw(50, 300, 3000, 'calc', 215);
close(calculated.kw, 300 * 3000 / 9549, 'torque times RPM fallback');
equal(calculated.approximate, true, 'calculated power marked approximate');
close(Calc.powerValue(100, 'hp'), 134.102, 'kW to hp');
close(Calc.powerValue(100, 'ps'), 135.962, 'kW to PS');
equal(Calc.powerUnit('kw'), 'kW', 'kW unit label');

console.log('PERFORMANCE calculations: ' + checks + ' checks passed');
