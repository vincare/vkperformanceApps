'use strict';
// Integrity, model selection, PNG decode, renderer size and exhaust overlay checks.
//   node kit/tools/test_performance_car_images.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const app = require('../../apps/performance/app.json');
const Cars = require('../../apps/performance/car_images');
const FlapUi = require('../../apps/performance/flap_ui');
const Record = require('../runtime/record');
const { withAlpha } = require('../runtime/canvas');

const hashes = {
    M340i_Blue: '6dc733f7ee023ef8e7f1083943c9f06fe0884ff65edbe2a538f282f68ab7f6a4',
    M340i_Red: 'b4b685a11ca1dd1836932d841f9ecb032ef4644ed44021b963c60d91072d8458',
    M340i_Black: 'ec636801caeae0216236b86c91739f04272a67dbbd6dd040a40aeca118a3ed01',
    M440i_Blue: '4ed71ced8cceb1f8454d6e2e905dda0a3693de427b4f7ae5234640b92401d6fa',
    M440i_Red: '51bb0f788220ce37bbfb98f8e9523db62683c5ba3d9132e66f3f9df0b92c1b84',
    M440i_Black: '25f906b4b2292593b9b4bda030414d5bb6063d3b59852b20b2fbe276b1fd163c',
};
const setting = app.settings.find((entry) => entry.key === 'carModel');
assert(setting && setting.label === 'Car Model' && setting.type === 'choice', 'Car Model is a choice setting');
assert.strictEqual(setting.default, 'M340i_Blue', 'default is the original M340i Blue PNG');
assert.deepStrictEqual(setting.options.map((entry) => entry[0]), Cars.MODELS.map((entry) => entry.key), 'six model choices');
assert.strictEqual(Cars.model(undefined).key, 'M340i_Blue', 'missing choice falls back to M340i Blue');
assert.strictEqual(Cars.MODELS.length, 6, 'six supported source images');

// Exercise the exact MGU Settings class used in the car: changing Car Model
// writes settings.json, and a new Settings instance reads that selection back.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-car-model-'));
try {
    const mguSource = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mgu.js'), 'utf8');
    const match = mguSource.match(/class Settings[\s\S]*?\n}\n/);
    assert(match, 'locate the real persisted settings implementation');
    const exported = new Function('fs', 'path', 'DATA_DIR', 'log', match[0] + '\nreturn { Settings };')(
        fs, path, dataDir, { warn: () => {}, error: () => {} });
    const firstRun = new exported.Settings(app.settings);
    assert.strictEqual(firstRun.get('carModel'), 'M340i_Blue', 'fresh MGU settings use the default model');
    firstRun.set('carModel', 'M440i_Red');
    const afterRestart = new exported.Settings(app.settings);
    assert.strictEqual(afterRestart.get('carModel'), 'M440i_Red', 'selected model persists after app restart');
} finally {
    try { fs.unlinkSync(path.join(dataDir, 'settings.json')); } catch (e) {}
    try { fs.rmdirSync(dataDir); } catch (e) {}
}

const sourceDir = path.join(__dirname, '..', '..', 'apps', 'performance', 'assets', 'car-models');
const outputHashes = [];
for (const model of Cars.MODELS) {
    const source = fs.readFileSync(path.join(sourceDir, model.file));
    assert.strictEqual(crypto.createHash('sha256').update(source).digest('hex'), hashes[model.key], model.file + ' remains byte-for-byte original');
    const loaded = Cars.load(model.key, '#050506');
    const image = Record.imageById.get(loaded.id);
    assert(image, model.key + ' registers a renderer image');
    assert.strictEqual(image.w, 1023, model.key + ' is downscaled below renderer width limit');
    assert.strictEqual(image.h, 682, model.key + ' keeps the exact original aspect ratio');
    assert.strictEqual(image.data.length, image.w * image.h * 4, model.key + ' RGBA data is complete');
    assert.strictEqual(model.tips.length, 4, model.key + ' has four source-specific exhaust anchors');
    const tips = loaded.exhaustTips;
    assert(tips.every((p) => p.length === 2 && p[0] > 0 && p[0] < 1 && p[1] > 0 && p[1] < 1), model.key + ' anchors are normalized within its PNG');
    assert.strictEqual(loaded.model.chassis, model.key.indexOf('M440i') === 0 ? 'G22' : 'G20', model.key + ' title uses the selected chassis');
    outputHashes.push(crypto.createHash('sha256').update(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength)).digest('hex'));

    const fit = FlapUi.contain({ x: 20, y: 30, w: 900, h: 240 }, loaded.width, loaded.height);
    assert(fit.x >= 20 && fit.y >= 30 && fit.x + fit.w <= 920 && fit.y + fit.h <= 270, model.key + ' contain fit stays inside panel');
    assert(Math.abs(fit.w / fit.h - loaded.width / loaded.height) < 1e-9, model.key + ' contain fit preserves aspect ratio');

    const recorder = new Record.Recorder(1600, 520);
    FlapUi.drawSmoke(recorder, { withAlpha }, {}, { exhaustTips: tips }, fit, 1500);
    assert(recorder.words().length > 0, model.key + ' smoke overlay draws from configured tips');
}
assert.strictEqual(new Set(outputHashes).size, 6, 'each model choice loads a distinct supplied image');
assert.strictEqual(app.version, '0.6.3', 'app version matches the update');
console.log('PERFORMANCE car images: ' + (6 * 11 + 10) + ' checks passed');
