'use strict';

// M Vitals-compatible conversions for the RPM, torque, Sport Display power,
// and boost paths used by PERFORMANCE.
function finite(value) { return typeof value === 'number' && isFinite(value); }

function scale(raw, config) {
    if (!finite(raw) || !config || raw === config.invalid ||
        (config.invalidFrom != null && raw >= config.invalidFrom)) return null;
    const value = raw * config.factor + (config.offset || 0);
    return finite(value) ? value : null;
}

function rpm(raw, config) {
    const value = scale(raw, config);
    return value !== null && raw >= 0 ? value : null;
}

function torque(raw, config) {
    const value = scale(raw, config);
    return value === null || raw < 0 ? null : Math.max(0, value);
}

function percentage(raw, config) {
    const value = scale(raw, config);
    return value !== null && value >= 0 && value <= 100 ? value : null;
}

function fesBoostBar(raw, pressureUnit, config) {
    let value = scale(raw, config);
    if (value === null || raw < 0) return null;
    // M Vitals: FES is in 0.01 car-pressure-unit steps; 0.1 psi per step
    // needs conversion to bar, while bar and kPa both reduce to 0.01 bar/bit.
    if (pressureUnit === 'PSI') value = value * 10 / 14.5038;
    return finite(value) && value >= -1 && value <= 4 ? value : null;
}

function dmeBoostBar(absoluteKpa, barometricKpa) {
    if (!finite(absoluteKpa) || !finite(barometricKpa)) return null;
    const value = (absoluteKpa - barometricKpa) / 100;
    return value >= -1 && value <= 4 ? value : null;
}

function powerKw(powerPercent, torqueNm, engineRpm, source, maxPowerKw) {
    if (source !== 'calc' && finite(powerPercent) && powerPercent >= 0 && powerPercent <= 100 &&
        finite(maxPowerKw) && maxPowerKw > 0) {
        return { kw: powerPercent / 100 * maxPowerKw, source: 'BMW SPORT DISPLAY', approximate: false };
    }
    if (finite(torqueNm) && finite(engineRpm)) {
        return { kw: Math.max(0, torqueNm * engineRpm / 9549), source: 'TORQUE × RPM', approximate: true };
    }
    return null;
}

function powerValue(kw, unit) {
    if (!finite(kw)) return null;
    return kw * ({ kw: 1, hp: 1.34102, ps: 1.35962 }[unit] || 1);
}

function powerUnit(unit) { return ({ kw: 'kW', hp: 'hp', ps: 'PS' }[unit] || 'hp'); }

module.exports = { scale, rpm, torque, percentage, fesBoostBar, dmeBoostBar, powerKw, powerValue, powerUnit };
