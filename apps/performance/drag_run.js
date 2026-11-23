'use strict';

const MPH_KMH = 1.609344;
const MAX_TRACE_POINTS = 400;
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
        { key: '200-300', label: '200–300 KM/H', from: 200, to: 300 },
    ];
    const selected = DISTANCES[distance] || DISTANCES.qm;
    return speed.concat([{ key: selected.key, label: selected.label, dist: selected.metres }]);
}

/** Every split the timer measures: all speed splits + all distances at once. */
function allSplits(unit) {
    const speed = splits(unit, 'qm').filter((s) => !s.dist);
    return speed.concat([DISTANCES.em, DISTANCES.qm, DISTANCES.m1000]
        .map((d) => ({ key: d.key, label: d.label, dist: d.metres })));
}

function bestKey(split, unit, rollout) {
    return split + '@' + (unit === 'mph' ? 'mph' : 'kmh') + (rollout ? '@ro' : '');
}

function speedValue(kmh, unit) { return unit === 'mph' ? kmh / MPH_KMH : kmh; }
function speedName(unit) { return unit === 'mph' ? 'MPH' : 'KM/H'; }
function seconds(value) { return typeof value === 'number' && isFinite(value) ? value.toFixed(2) : '--.--'; }

/** Peak longitudinal G estimated from a [t, km/h] speed trace (rolling runs have no G sensor data). */
function peakGFromTrace(trace) {
    if (!Array.isArray(trace) || trace.length < 2) return null;
    let peak = 0;
    for (let i = 1; i < trace.length; i++) {
        const dt = trace[i][0] - trace[i - 1][0], dv = trace[i][1] - trace[i - 1][1];
        if (dt > 0) { const g = dv / 3.6 / dt / 9.80665; if (g > peak) peak = g; }
    }
    return peak > 0.05 ? peak : null;
}

/** Keep traces small while preserving their first/last points and overall shape. */
function compactTrace(points, limit) {
    if (!Array.isArray(points)) return [];
    const max = Math.max(2, Math.floor(limit || MAX_TRACE_POINTS));
    if (points.length <= max) return points;
    const compact = new Array(max), span = points.length - 1;
    for (let i = 0; i < max; i++) compact[i] = points[Math.round(i * span / (max - 1))];
    return compact;
}

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

/**
 * Rolling-start interval splits (Dragy style): an upward crossing of `from`
 * arms the interval, an upward crossing of `to` finishes it, a dip back below
 * `from` cancels it. Works while cruising — no standstill launch needed, so
 * 100-200 / 200-300 / 60-130mph measure any time the car accelerates through.
 * Crossing times are interpolated between samples like RunTimer does.
 * feed(t, kmh) -> { key: seconds } for intervals completed on this sample.
 */
class RollingSplits {
    constructor(splits) {
        this.splits = (splits || []).filter((s) => !s.dist && s.from > 0);
        this.prev = null;
        this.pending = {};
    }

    feed(t, v) {
        const done = {};
        const p = this.prev;
        if (p && isFinite(p.v) && isFinite(v)) {
            const dt = Math.max(0, t - p.t) / 1000;
            const cross = (target) => p.t + ((target - p.v) / Math.max(1e-6, v - p.v)) * (t - p.t);
            for (const s of this.splits) {
                const st = this.pending[s.key];
                if (v < s.from) { delete this.pending[s.key]; continue; }
                if (st === undefined) {
                    if (p.v < s.from) this.pending[s.key] = { t: cross(s.from), dist: 0, vmax: 0, trace: [] };
                    continue;
                }
                st.dist += ((p.v + v) / 2 / 3.6) * dt;
                st.vmax = Math.max(st.vmax, v);
                const lastT = st.trace.length ? st.trace[st.trace.length - 1][0] : 0;
                if (t - st.t - lastT * 1000 >= 60) st.trace.push([(t - st.t) / 1000, v]);
                if (p.v < s.to && v >= s.to) {
                    done[s.key] = {
                        s: (cross(s.to) - st.t) / 1000, dist: st.dist, vmax: s.to,
                        trace: st.trace.concat([[(cross(s.to) - st.t) / 1000, s.to]]),
                    };
                    delete this.pending[s.key];
                }
            }
        }
        this.prev = { t, v };
        return done;
    }
}

module.exports = { MPH_KMH, MAX_TRACE_POINTS, DISTANCES, splits, allSplits, bestKey, speedValue, speedName, seconds, compactTrace, peakGFromTrace, WheelspinEstimate, RollingSplits };
