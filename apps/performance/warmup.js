'use strict';
/**
 * warmup.js - warm-up tracking for the WARMUP page, ported from the Warm-Up app:
 *
 *   - 20-minute temperature history (oil / coolant / gearbox), sampled every 5 s
 *   - "ready in ~N min" per fluid from the measured warm-up rate (least squares over
 *     the last ~3 min, blended with typical drive/idle rates until enough is measured)
 *   - safe rev limit climbing from the cold limit to the redline with oil temperature
 *   - turbo cool-down: hard driving (rpm or power over the thresholds) builds a
 *     cool-down need (30 s - 3 min); gentle driving / idling counts it down
 *   - cold starts: engine starts counted while the app runs (cold oil, revved cold),
 *     kept in the settings ('coldStarts') so the counts go on over drives
 *
 *   const w = new Warmup({ settings });
 *   w.sample({ rpm, speed, oil, coolant, gearbox, kw });     // on each signal update
 *   w.eta('oil', oil, target, d) -> { state, min, rate, est }
 *   w.cooldown() -> { needS, left, gentle, done }            w.limit(oil) -> rpm | null
 */
const RUN_RPM = 400, STOP_RPM = 300;
const OFF_MS = 30000;              // stopped this long: the next run is a new start
const OIL_WAIT_MS = 30000;         // the first oil reading after a start, at most this late
const COLD_C = 40;
const LAST_STARTS = 8;
const HARD_RPM = 3800, HARD_KW = 90;
const GENTLE_RPM = 2800, GENTLE_KW = 40;
const COOL_MIN = 30, COOL_MAX = 180;
const TYPICAL = { oil: { drive: 4, idle: 1.5 }, coolant: { drive: 7, idle: 3 }, gearbox: { drive: 3, idle: 0.8 } };
const HIST = { oil: 1, coolant: 2, gearbox: 5 };

const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };

class ColdStarts {
    constructor(settings, limit, warm) {
        this.settings = settings;
        this.limit = limit || (() => null);
        this.warm = warm || (() => 90);
        this.oilC = null;
        this.running = false;
        this.stoppedAt = -Infinity;
        this.run = null;
        const s = settings.get('coldStarts');
        this.s = s && isNum(s.starts) ? s : this._empty();
    }
    _empty() { return { starts: 0, cold: 0, revved: 0, since: Date.now(), last: [] }; }
    stats() { return this.s; }
    reset() { this.s = this._empty(); this._save(); }
    oil(c) {
        if (!isNum(c)) return;
        this.oilC = c;
        const r = this.run;
        if (r && !r.counted && Date.now() - r.at <= OIL_WAIT_MS) this._count(c);
    }
    rpm(r) {
        if (!isNum(r)) return;
        const t = Date.now();
        if (!this.running && r > RUN_RPM) {
            this.running = true;
            if (t - this.stoppedAt >= OFF_MS || !this.run) {
                this.run = { at: t, oil: null, cold: false, revved: false, counted: false };
                if (isNum(this.oilC)) this._count(this.oilC);
            }
        } else if (this.running && r < STOP_RPM) {
            this.running = false;
            this.stoppedAt = t;
        }
        const run = this.run;
        if (this.running && run && run.counted && !run.revved && isNum(this.oilC) && this.oilC < this.warm()) {
            const lim = this.limit(this.oilC);
            if (isNum(lim) && r > lim) { run.revved = true; this.s.revved += 1; this._save(); }
        }
    }
    _count(c) {
        const r = this.run;
        r.counted = true;
        r.oil = Math.round(c);
        r.cold = c < COLD_C;
        this.s.starts += 1;
        if (r.cold) this.s.cold += 1;
        this.s.last = [r].concat(this.s.last.filter((x) => x !== r)).slice(0, LAST_STARTS);
        this._save();
    }
    _save() { this.settings.set('coldStarts', this.s); }
}

class Warmup {
    constructor(o) {
        this.settings = o.settings;
        this.redline = o.redline || (() => 7000);
        this.coldRpm = o.coldRpm || (() => 3500);
        this.hist = [];             // [t, oil, coolant, rpm, speed, gearbox] every 5 s, 20 min
        this.lastHist = 0; this.lastT = 0;
        this.hardS = 0; this.needS = 0; this.cool = 0; this.doneAt = 0;
        this.cs = new ColdStarts(o.settings, (oil) => this.limit(oil), () => this.settings.get('warmOil') || 90);
    }

    /** The safe rev limit for the oil's temperature: cold limit -> redline from 30 deg C to warm. */
    limit(oil) {
        const warm = this.settings.get('warmOil') || 90;
        const red = this.redline(), cold = Math.min(this.coldRpm(), red);
        if (!isNum(oil)) return null;
        if (oil >= warm) return red;
        return Math.round((cold + (red - cold) * clamp((oil - 30) / (warm - 30), 0, 1)) / 100) * 100;
    }

    /**
     * One live sample (called on every metric update). d: { rpm, speed, oil, coolant, gearbox, kw }.
     * Times are on a steady clock so a head-unit clock jump can't break the trend.
     */
    sample(d, countStarts) {
        const m = mono(), t = Date.now();
        const dt = this.lastT ? clamp(t - this.lastT, 0, 250) / 1000 : 0;
        this.lastT = t;
        if (isNum(d.rpm)) {
            const hard = d.rpm > HARD_RPM || (isNum(d.kw) && d.kw > HARD_KW);
            const gentle = d.rpm < GENTLE_RPM && (!isNum(d.kw) || d.kw < GENTLE_KW);
            if (hard) {
                this.hardS += dt; this.cool = 0; this.doneAt = 0;
                if (this.hardS > 8) this.needS = clamp(COOL_MIN + this.hardS * 3, COOL_MIN, COOL_MAX);
            } else if (this.needS > 0 && gentle) {
                this.cool += dt;
                if (this.cool >= this.needS && !this.doneAt) this.doneAt = m;
            } else if (!this.needS) {
                this.hardS = Math.max(0, this.hardS - dt * 0.2);
            }
            if (this.doneAt && m - this.doneAt > 20000) { this.hardS = 0; this.needS = 0; this.cool = 0; this.doneAt = 0; }
        }
        if (m - this.lastHist > 5000 && (isNum(d.oil) || isNum(d.coolant) || isNum(d.gearbox))) {
            this.lastHist = m;
            this.hist.push([m, d.oil, d.coolant, d.rpm, d.speed, d.gearbox]);
            while (this.hist.length > 240) this.hist.shift();
        }
        if (countStarts !== false) {
            this.cs.rpm(d.rpm);
            this.cs.oil(d.oil);
        }
    }

    reset() { this.hist.length = 0; this.hardS = 0; this.needS = 0; this.cool = 0; this.doneAt = 0; this.lastT = 0; }

    /** deg C per minute over the last ~3 min (least squares) and the time it covers (ms). */
    measured(idx) {
        const last = this.hist.length ? this.hist[this.hist.length - 1][0] : 0;
        const pts = this.hist.filter((h) => isNum(h[idx]) && last - h[0] < 180000);
        if (pts.length < 4) return { rate: null, span: 0 };
        const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[idx], 0) / n;
        let num = 0, den = 0;
        pts.forEach((p) => { num += (p[0] - mx) * (p[idx] - my); den += (p[0] - mx) * (p[0] - mx); });
        return { rate: den ? num / den * 60000 : null, span: pts[n - 1][0] - pts[0][0] };
    }

    /**
     * Warm-up estimate for 'oil' / 'coolant' / 'gearbox': { state, min, rate, est }.
     * state: ready | warming | off (engine not running) | stalled | none (no data).
     */
    eta(key, temp, target, d) {
        if (!isNum(temp)) return { state: 'none' };
        if (temp >= target) return { state: 'ready' };
        if (isNum(d.rpm) && d.rpm < 300) return { state: 'off' };
        const m = this.measured(HIST[key]);
        const typ = TYPICAL[key][isNum(d.speed) && d.speed > 10 ? 'drive' : 'idle'];
        const w = clamp(m.span / 120000, 0, 1);
        const rate = isNum(m.rate) ? w * m.rate + (1 - w) * typ : typ;
        if (w > 0.8 && rate < 0.15) return { state: 'stalled', rate };
        const min = (target - temp) / Math.max(0.15, rate);
        return { state: 'warming', min, rate, est: w < 0.5 };
    }

    /** Turbo cool-down: { needS, left, gentle, done }. needS > 0 while a cool-down is asked for. */
    cooldown() {
        const left = this.needS > 0 ? Math.max(0, this.needS - this.cool) : 0;
        return { needS: this.needS, left, gentle: this.needS > 0 && this.cool > 0, done: !!this.doneAt };
    }

    /** The 20-min trend: [[mono, oil, coolant, rpm, speed, gearbox], ...]. */
    trend() { return this.hist; }

    /** Demo mode: synthesise a believable 20-min warm-up so the trend isn't empty in the emulator. */
    seedDemo() {
        if (this.demoSeeded) return;
        this.demoSeeded = true;
        const m = mono();
        const climb = (cold, hot, p) => cold + (hot - cold) * (1 - Math.exp(-4 * p));
        for (let i = 0; i < 240; i++) {
            const p = i / 240;
            this.hist.push([m - (240 - i) * 5000,
                climb(28, 88, p) + Math.sin(i * 0.31) * 1.4,
                climb(24, 90, p) + Math.sin(i * 0.27 + 1) * 1.1,
                950 + Math.sin(i * 0.2) * 350,
                i > 120 ? 45 + Math.sin(i * 0.15) * 30 : 0,
                climb(21, 76, p) + Math.sin(i * 0.36 + 2) * 0.9]);
        }
        this.demoSeededN = this.hist.length;
        this.lastHist = m;
    }

    /** Demo off: drop the synthesised points, keep anything sampled since. */
    clearDemo() {
        if (!this.demoSeeded) return;
        this.hist.splice(0, this.demoSeededN || 0);
        this.demoSeeded = false; this.demoSeededN = 0;
    }

    coldStarts() { return this.cs.stats(); }
    resetColdStarts() { this.cs.reset(); }
}

module.exports = { Warmup, HARD_RPM, HARD_KW, GENTLE_RPM, GENTLE_KW, COLD_C };
