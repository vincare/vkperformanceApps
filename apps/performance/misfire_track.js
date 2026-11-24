'use strict';
/**
 * misfire_track.js - turns the engine unit's misfire counters into a log of every misfire, across
 * drives. Ported from aref_misfire (ID7-MAIN_APPS2) for PERFORMANCE's CAR DATA engine info.
 *
 * The DME counts misfires per cylinder over OBD service 06 (SAE J1979): MID A2.. = cylinder 1..,
 * TID 0C = misfires this driving cycle, TID 0B = a weighted average over the last 10 cycles. The 0C
 * count restarts at 0 every engine start, so each rise between readings is an event and a count
 * lower than the last one is a new drive.
 *
 *   const t = new Tracker(saved);
 *   const ev = t.feed([0, 2, 0, 0], Date.now(), { rpm, speed, coolant, oil, gear, torque, mode }, avg10);
 *   t.state -> { drive, drives, events, totals, last, avg10, reads }  (JSON, persisted by the app)
 *
 * Node 8: no ?., ??, object spread or optional catch binding.
 */

const MAX_EVENTS = 2000;
const MAX_DRIVES = 300;
const NEW_DRIVE_GAP_MS = 10 * 60000;

class Tracker {
    constructor(saved) {
        const s = saved || {};
        this.state = {
            drive: s.drive || null,
            drives: s.drives || [],
            events: s.events || [],
            totals: s.totals || [],
            last: s.last || null,
            avg10: s.avg10 || null,
            reads: s.reads || 0,
        };
    }

    feed(counts, at, ctx, avg10) {
        const S = this.state;
        if (!Array.isArray(counts) || !counts.length) return [];
        S.reads++;
        if (Array.isArray(avg10) && avg10.length === counts.length) S.avg10 = avg10.slice();
        const prev = S.last && S.last.counts && S.last.counts.length === counts.length ? S.last.counts : null;
        const dropped = prev && counts.some((c, i) => num(c) && num(prev[i]) && c < prev[i]);
        const stale = S.last && at - S.last.at > NEW_DRIVE_GAP_MS && counts.every((c) => !num(c) || c === 0);
        const fresh = !S.drive || dropped || stale;
        const out = [];
        if (fresh) {
            this._endDrive();
            S.drive = { id: (S.drives.length ? S.drives[S.drives.length - 1].id : 0) + 1, start: at, end: at, counts: counts.map(() => 0), first: counts.slice(), avg10: S.avg10 ? S.avg10.slice() : null };
            counts.forEach((c, i) => { if (num(c) && c > 0) out.push(this._event(at, i, c, ctx, true)); });
        } else {
            counts.forEach((c, i) => {
                const p = prev ? prev[i] : null;
                if (num(c) && num(p) && c > p) out.push(this._event(at, i, c - p, ctx, false));
            });
        }
        S.drive.end = at;
        S.last = { at: at, counts: counts.slice() };
        if (S.events.length > MAX_EVENTS) S.events.splice(0, S.events.length - MAX_EVENTS);
        return out;
    }

    _event(at, i, n, ctx, early) {
        const S = this.state;
        while (S.totals.length <= i) S.totals.push(0);
        while (S.drive.counts.length <= i) S.drive.counts.push(0);
        S.totals[i] += n;
        S.drive.counts[i] += n;
        const e = { at: at, drive: S.drive.id, cyl: i + 1, n: n, ctx: ctx || {}, early: !!early };
        S.events.push(e);
        return e;
    }

    _endDrive() {
        const S = this.state;
        if (!S.drive) return;
        S.drives.push(S.drive);
        if (S.drives.length > MAX_DRIVES) S.drives.splice(0, S.drives.length - MAX_DRIVES);
        S.drive = null;
    }

    driveTotal() { return this.state.drive ? sum(this.state.drive.counts) : 0; }

    worst(counts) {
        let best = -1, at = 0;
        (counts || this.state.totals).forEach((c, i) => { if (num(c) && c > best) { best = c; at = i + 1; } });
        return best > 0 ? at : 0;
    }

    recentDrives(n) {
        const all = this.state.drives.concat(this.state.drive ? [this.state.drive] : []);
        return all.slice(-n);
    }
}

function num(x) { return typeof x === 'number' && isFinite(x); }
function sum(a) { return (a || []).reduce((s, x) => s + (num(x) ? x : 0), 0); }

function severity(n, threshold) {
    if (!n) return 'ok';
    return n >= (threshold || 10) ? 'many' : 'few';
}

function csv(events) {
    const head = 'time,drive,cylinder,misfires,before_first_reading,rpm,speed_kmh,coolant_c,oil_c,gear,torque_nm,drive_mode';
    const q = (v) => (v === undefined || v === null ? '' : String(v).replace(/,/g, ' '));
    return [head].concat(events.map((e) => {
        const c = e.ctx || {};
        return [new Date(e.at).toISOString(), e.drive, e.cyl, e.n, e.early ? 'yes' : 'no', q(round(c.rpm)), q(round(c.speed)), q(round(c.coolant)), q(round(c.oil)), q(c.gear), q(round(c.torque)), q(c.mode)].join(',');
    })).join('\n') + '\n';
}
function round(x) { return num(x) ? Math.round(x) : x; }

module.exports = { Tracker, severity, csv, sum };
