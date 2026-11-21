'use strict';

const MPH_KMH = 1.609344;
const DISTANCES = {
    qm: { key: 'qm', label: '1/4 MILE', metres: 402.336 },
    em: { key: 'em', label: '1/8 MILE', metres: 201.168 },
    m1000: { key: 'm1000', label: '1000 M', metres: 1000 },
};

function splits(unit, distance) {
    const speed = unit === 'mph' ? [
        { key: '0-30mph', label: '0–30 MPH', from: 0, to: 30 * MPH_KMH },
        { key: '0-60mph', label: '0–60 MPH', from: 0, to: 60 * MPH_KMH },
        { key: '60-130mph', label: '60–130 MPH', from: 60 * MPH_KMH, to: 130 * MPH_KMH },
        { key: '0-100mph', label: '0–100 MPH', from: 0, to: 100 * MPH_KMH },
    ] : [
        { key: '0-50', label: '0–50 KM/H', from: 0, to: 50 },
        { key: '0-100', label: '0–100 KM/H', from: 0, to: 100 },
        { key: '100-200', label: '100–200 KM/H', from: 100, to: 200 },
        { key: '0-200', label: '0–200 KM/H', from: 0, to: 200 },
    ];
    const selected = DISTANCES[distance] || DISTANCES.qm;
    return speed.concat([{ key: selected.key, label: selected.label, dist: selected.metres }]);
}

function bestKey(split, unit, rollout) {
    return split + '@' + (unit === 'mph' ? 'mph' : 'kmh') + (rollout ? '@ro' : '');
}

function speedValue(kmh, unit) { return unit === 'mph' ? kmh / MPH_KMH : kmh; }
function speedName(unit) { return unit === 'mph' ? 'MPH' : 'KM/H'; }
function seconds(value) { return typeof value === 'number' && isFinite(value) ? value.toFixed(2) : '--.--'; }

/** A short-window wheelspin estimate from body acceleration and the vehicle speed signal. */
class WheelspinEstimate {
    constructor() {
        this.bias = null;
        this.biasSamples = 0;
        this.resetRun();
    }

    resetRun() {
        this.launchAt = null;
        this.integratedKmh = 0;
        this.lastAccel = null;
        this.lastSpeedAt = null;
        this.peakPercent = 0;
        this.secondsAbove = 0;
        this.seen = false;
        this.standing = null;
    }

    launch(at) {
        this.resetRun();
        this.launchAt = at;
    }

    accel(at, metresPerSecondSquared) {
        if (typeof metresPerSecondSquared !== 'number' || !isFinite(metresPerSecondSquared)) return;
        if (this.launchAt === null) {
            if (this.standing === true) {
                const factor = Math.min(1, 50 / 2000);
                this.bias = this.bias === null ? metresPerSecondSquared
                    : this.bias + (metresPerSecondSquared - this.bias) * factor;
                this.biasSamples++;
            }
            return;
        }
        if (at - this.launchAt > 3000) return;
        if (this.lastAccel) {
            const bias = this.bias === null ? 0 : this.bias;
            const dt = Math.max(0, at - this.lastAccel.at) / 1000;
            this.integratedKmh += ((this.lastAccel.value + metresPerSecondSquared) / 2 - bias) * dt * 3.6;
        }
        this.lastAccel = { at, value: metresPerSecondSquared };
        this.seen = true;
    }

    speed(at, kmh) {
        if (typeof kmh !== 'number' || !isFinite(kmh)) return;
        this.standing = kmh < 0.5;
        if (this.launchAt === null || at - this.launchAt > 3000 || !this.seen) return;
        const dt = this.lastSpeedAt === null ? 0 : Math.max(0, at - this.lastSpeedAt) / 1000;
        this.lastSpeedAt = at;
        if (kmh < 8 || this.integratedKmh <= 0) return;
        const pct = (kmh - this.integratedKmh) / this.integratedKmh * 100;
        this.peakPercent = Math.max(this.peakPercent, pct);
        if (pct > 10) this.secondsAbove += dt;
    }

    result() {
        return this.seen ? { peak: Math.round(Math.max(0, this.peakPercent)), seconds: Math.round(this.secondsAbove * 10) / 10 } : null;
    }
}

module.exports = { MPH_KMH, DISTANCES, splits, bestKey, speedValue, speedName, seconds, WheelspinEstimate };
