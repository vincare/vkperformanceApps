'use strict';

// Read-only road-dyno pull detector and curve analysis, adapted from upstream Virtual Dyno logic.
const BIN_RPM = 100;
const MIN_RPM_SPAN = 1500;
const AIR_DENSITY = 1.2;
const ROLLING_COEFFICIENT = 0.013;
const DRAG_CDA = { coupe: 0.62, wagon: 0.72, suv: 0.95 };

function finite(value) { return typeof value === 'number' && isFinite(value); }

/** Explain why a live sample is not yet eligible to start a road pull. */
function gateReason(data) {
    if (!data || !finite(data.rpm) || !finite(data.speedKmh) || !finite(data.longitudinalG)) return 'signals';
    if (data.speedKmh <= 15) return 'speed';
    if (data.rpm <= 1200) return 'rpm';
    if (data.longitudinalG <= 0.12) return 'acceleration';
    return 'ready';
}

/** Crankshaft power in watts, using the same road-load estimate as the DYNO app. */
function estimatePowerW(speedKmh, longitudinalG, setup) {
    if (!finite(speedKmh) || !finite(longitudinalG) || !setup ||
        !finite(setup.weight) || setup.weight <= 0 ||
        !finite(setup.loss) || setup.loss < 0 || setup.loss >= 50) return null;
    const speed = speedKmh / 3.6;
    const acceleration = longitudinalG * 9.80665;
    const cda = DRAG_CDA[setup.body] || DRAG_CDA.coupe;
    const wheel = setup.weight * acceleration * speed +
        0.5 * AIR_DENSITY * cda * speed * speed * speed +
        ROLLING_COEFFICIENT * setup.weight * 9.80665 * speed;
    const crank = wheel / (1 - setup.loss / 100);
    return finite(crank) && crank >= 0 ? crank : null;
}

/** Bin, smooth and derive torque from a full-throttle pull. */
function analyse(points, startedAt, setup) {
    if (!Array.isArray(points) || points.length < 16) return null;
    const bins = Object.create(null);
    points.forEach((point) => {
        const rpm = Math.round(point.rpm / BIN_RPM) * BIN_RPM;
        (bins[rpm] = bins[rpm] || []).push(point);
    });
    const keys = Object.keys(bins).map(Number).sort((a, b) => a - b);
    const raw = keys.map((rpm) => ({
        rpm,
        powerW: bins[rpm].reduce((sum, point) => sum + point.powerW, 0) / bins[rpm].length,
    }));
    const curve = raw.map((point, index) => {
        const window = raw.slice(Math.max(0, index - 2), index + 3);
        const powerW = Math.max(0, window.reduce((sum, item) => sum + item.powerW, 0) / window.length);
        const torqueNm = point.rpm > 0 ? powerW / (point.rpm * Math.PI / 30) : 0;
        return { rpm: point.rpm, powerW, torqueNm };
    });
    if (!curve.length) return null;
    const peakPower = curve.reduce((best, point) => point.powerW > best.powerW ? point : best, curve[0]);
    const peakTorque = curve.reduce((best, point) => point.torqueNm > best.torqueNm ? point : best, curve[0]);
    return {
        at: startedAt,
        curve,
        peakP: peakPower.powerW,
        peakPrpm: peakPower.rpm,
        peakT: peakTorque.torqueNm,
        peakTrpm: peakTorque.rpm,
        weight: setup.weight,
        loss: setup.loss,
        body: setup.body,
        v0: points[0].speedKmh,
        v1: points[points.length - 1].speedKmh,
    };
}

class Recorder {
    constructor() {
        this.pull = null;
        this.status = 'idle';
        this.statusUntil = 0;
        this.livePowerW = null;
        this.lastSampleAt = 0;
    }

    /** Feed one fresh live sample; returns { type: 'run'|'short', run? } on completion. */
    sample(data, at, setup) {
        if (!data || !finite(data.rpm) || !finite(data.speedKmh) || !finite(data.longitudinalG)) {
            return this.tick(at, setup);
        }
        if (at - this.lastSampleAt < 40) return this.tick(at, setup);
        this.lastSampleAt = at;
        const hard = data.longitudinalG > 0.12 && data.speedKmh > 15 && data.rpm > 1200;
        this.livePowerW = hard ? estimatePowerW(data.speedKmh, data.longitudinalG, setup) : null;
        if (hard && finite(this.livePowerW)) {
            if (!this.pull) {
                this.pull = { segments: [], startedAt: at };
                this.status = 'recording';
            }
            const ratio = data.rpm / data.speedKmh;
            let segment = this.pull.segments[this.pull.segments.length - 1];
            if (!segment || Math.abs(ratio - segment.ratio) / segment.ratio > 0.04) {
                segment = { ratio, points: [] };
                this.pull.segments.push(segment);
            }
            segment.ratio += (ratio - segment.ratio) * 0.1;
            segment.points.push({ rpm: data.rpm, powerW: this.livePowerW, speedKmh: data.speedKmh });
            this.pull.lastHardAt = at;
            return null;
        }
        if (this.pull && at - this.pull.lastHardAt > 500) return this.finish(at, setup);
        return null;
    }

    /** End an interrupted run after the source stops sending fresh samples. */
    tick(at, setup) {
        if (this.pull && at - this.pull.lastHardAt > 500) return this.finish(at, setup);
        if (this.status !== 'recording' && this.status !== 'idle' && at >= this.statusUntil) this.status = 'idle';
        return null;
    }

    finish(at, setup) {
        const pull = this.pull;
        this.pull = null;
        this.livePowerW = null;
        if (!pull) return null;
        const segments = pull.segments.map((segment) => {
            const rpms = segment.points.map((point) => point.rpm);
            return { segment, span: rpms.length ? Math.max.apply(null, rpms) - Math.min.apply(null, rpms) : 0 };
        }).filter((item) => item.span >= MIN_RPM_SPAN && item.segment.points.length > 15)
            .sort((a, b) => a.segment.ratio - b.segment.ratio);
        const best = segments[0];
        if (!best) {
            this.status = 'short';
            this.statusUntil = at + 4000;
            return { type: 'short' };
        }
        const run = analyse(best.segment.points, pull.startedAt, setup);
        if (!run) {
            this.status = 'short';
            this.statusUntil = at + 4000;
            return { type: 'short' };
        }
        this.status = 'done';
        this.statusUntil = at + 6000;
        return { type: 'run', run };
    }

    reset() {
        this.pull = null;
        this.status = 'idle';
        this.statusUntil = 0;
        this.livePowerW = null;
        this.lastSampleAt = 0;
    }

    snapshot(at) {
        if (this.status !== 'recording' && this.status !== 'idle' && at >= this.statusUntil) this.status = 'idle';
        return { status: this.status, livePowerW: this.livePowerW };
    }
}

module.exports = { Recorder, estimatePowerW, analyse, gateReason, MIN_RPM_SPAN };
