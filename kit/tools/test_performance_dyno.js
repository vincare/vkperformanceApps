'use strict';
// The road-dyno pull detector and curve calculator ported into PERFORMANCE.
//   node kit/tools/test_performance_dyno.js
const Dyno = require('../../apps/performance/dyno');
let checks = 0;
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

const setup = { weight: 1750, body: 'coupe', loss: 15 };
ok(Dyno.gateReason(null) === 'signals', 'wait when a required signal is missing');
ok(Dyno.gateReason({ rpm: 2500, speedKmh: 0, longitudinalG: 0.2 }) === 'speed', 'require road speed');
ok(Dyno.gateReason({ rpm: 1000, speedKmh: 30, longitudinalG: 0.2 }) === 'rpm', 'require engine speed');
ok(Dyno.gateReason({ rpm: 2500, speedKmh: 30, longitudinalG: 0.12 }) === 'acceleration', 'require hard acceleration');
ok(Dyno.gateReason({ rpm: 2500, speedKmh: 30, longitudinalG: 0.2 }) === 'ready', 'arm with all pull conditions');
const expected = (1750 * (0.18 * 9.80665) * (50 / 3.6) +
    0.5 * 1.2 * 0.62 * Math.pow(50 / 3.6, 3) + 0.013 * 1750 * 9.80665 * (50 / 3.6)) / 0.85;
close(Dyno.estimatePowerW(50, 0.18, setup), expected, 'road-load / loss calculation');
ok(Dyno.estimatePowerW(50, 0.18, { weight: 0, body: 'coupe', loss: 15 }) === null, 'reject invalid vehicle weight');
ok(Dyno.estimatePowerW(50, 0.18, { weight: 1750, body: 'coupe', loss: 50 }) === null, 'reject invalid drivetrain loss');

const recorder = new Dyno.Recorder();
let result = null;
for (let i = 0; i < 40; i++) {
    const rpm = 2000 + i * 100;
    result = recorder.sample({ rpm, speedKmh: rpm / 70, longitudinalG: 0.18 }, i * 50, setup) || result;
}
ok(recorder.status === 'recording', 'detect a sustained full-throttle pull');
recorder.sample({ rpm: 5900, speedKmh: 5900 / 70, longitudinalG: 0.05 }, 2050, setup);
result = recorder.sample({ rpm: 5900, speedKmh: 5900 / 70, longitudinalG: 0.05 }, 2600, setup);
ok(result && result.type === 'run', 'finish a valid pull after throttle lift');
ok(result.run.peakP > 0 && result.run.peakT > 0, 'record peak power and derived torque');
ok(result.run.curve.length > 15, 'store the measured curve');
ok(result.run.peakPrpm >= 2000 && result.run.peakPrpm <= 5900, 'record RPM of peak power');

const short = new Dyno.Recorder();
for (let j = 0; j < 20; j++) {
    const rpm = 2000 + j * 30;
    short.sample({ rpm, speedKmh: rpm / 70, longitudinalG: 0.18 }, j * 50, setup);
}
short.sample({ rpm: 2500, speedKmh: 35, longitudinalG: 0.05 }, 1050, setup);
result = short.sample({ rpm: 2500, speedKmh: 35, longitudinalG: 0.05 }, 1600, setup);
ok(result && result.type === 'short' && short.status === 'short', 'do not report a short pull as a dyno result');

console.log('PERFORMANCE virtual dyno: ' + checks + ' checks passed');
