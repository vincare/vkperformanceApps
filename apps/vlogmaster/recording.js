'use strict';

const fs = require('fs');
const path = require('path');

function validId(id) { return /^[a-z0-9_-]{6,48}$/i.test(String(id || '')); }
function finite(v) { return typeof v === 'number' && isFinite(v); }

class RecordingStore {
    constructor(dataDir, log) {
        this.root = path.join(dataDir, 'vlogmaster');
        this.indexFile = path.join(this.root, 'index.json');
        this.log = log; this.active = null; this.flushTimer = null;
        this.logs = [];
        try { fs.mkdirSync(this.root, { recursive: true }); } catch (e) { /* report via app view */ }
        try {
            const doc = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
            if (Array.isArray(doc.logs)) this.logs = doc.logs.filter((x) => x && validId(x.id)).slice(0, 80);
            this.logs.forEach((x) => {
                if (x.status !== 'RECORDING') return;
                x.status = 'INTERRUPTED';
                const rows = this.samples(x.id), counts = Object.create(null), stats = Object.create(null);
                rows.forEach((r) => {
                    counts[r.key] = (counts[r.key] || 0) + 1;
                    if (!finite(r.value)) return;
                    const s = stats[r.key] || { min: r.value, max: r.value, sum: 0, n: 0 };
                    s.min = Math.min(s.min, r.value); s.max = Math.max(s.max, r.value); s.sum += r.value; s.n++;
                    stats[r.key] = s;
                });
                Object.keys(stats).forEach((k) => { const s = stats[k]; s.avg = s.n ? s.sum / s.n : null; delete s.sum; });
                x.sampleCount = rows.length; x.counts = counts; x.stats = stats;
                x.endedAt = rows.length ? rows[rows.length - 1].t : x.startedAt;
                x.durationMs = Math.max(0, x.endedAt - x.startedAt); x.activeDurationMs = x.durationMs;
                x.actualHz = x.durationMs > 0 ? Math.round(x.sampleCount * 1000 / x.durationMs * 100) / 100 : 0;
                x.channelHz = Object.create(null);
                Object.keys(counts).forEach((k) => { x.channelHz[k] = x.durationMs > 0 ? Math.round(counts[k] * 1000 / x.durationMs * 100) / 100 : 0; });
            });
        } catch (e) { /* first run */ }
        this._saveIndex();
    }

    _saveIndex() {
        try {
            const tmp = this.indexFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ version: 1, logs: this.logs.slice(0, 80) }));
            fs.renameSync(tmp, this.indexFile);
        } catch (e) { if (this.log) this.log.warn('VLogMaster index: ' + (e.message || e)); }
    }
    _file(id) { if (!validId(id)) throw new Error('invalid recording id'); return path.join(this.root, id + '.jsonl'); }
    list() { return this.logs.slice().sort((a, b) => b.startedAt - a.startedAt); }
    get(id) { return this.logs.find((x) => x.id === id) || null; }

    start(keys, channels, vehicle) {
        if (this.active) return false;
        const id = 'vlog_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
        const startedAt = Date.now();
        const units = Object.create(null);
        (channels || []).forEach((c) => { if (keys.indexOf(c.key) >= 0) units[c.key] = c.unit || ''; });
        const log = { id, name: 'VLog ' + new Date(startedAt).toISOString().replace('T', ' ').slice(0, 16), startedAt,
            endedAt: null, durationMs: 0, vehicle: vehicle || 'BMW vehicle · auto-detection pending', channels: keys.slice(), units,
            status: 'RECORDING', sampleCount: 0, actualHz: 0, counts: {}, stats: {} };
        this.logs.unshift(log); this.logs = this.logs.slice(0, 80);
        this.active = { log, batch: [], firstSampleAt: 0, lastSampleAt: 0, flushAt: Date.now(), activeMs: 0, activeSince: startedAt };
        try { fs.writeFileSync(this._file(id), ''); } catch (e) { this.logs.shift(); this.active = null; if (this.log) this.log.warn('VLogMaster start: ' + e.message); return false; }
        this._saveIndex();
        this.flushTimer = setInterval(() => this.flush(), 4000);
        return true;
    }

    record(key, metric) {
        const a = this.active;
        if (!a || a.log.status !== 'RECORDING' || !metric || a.log.channels.indexOf(key) < 0 || metric.status !== 'LIVE' || metric.value == null) return;
        const at = metric.at || Date.now();
        const row = { t: at, key, raw: metric.raw, value: metric.value, unit: metric.unit || '', source: metric.source || '' };
        a.batch.push(row); a.log.sampleCount++; a.log.counts[key] = (a.log.counts[key] || 0) + 1;
        if (!a.firstSampleAt) a.firstSampleAt = at;
        a.lastSampleAt = at;
        if (finite(metric.value)) {
            const s = a.log.stats[key] || { min: metric.value, max: metric.value, sum: 0, n: 0 };
            s.min = Math.min(s.min, metric.value); s.max = Math.max(s.max, metric.value); s.sum += metric.value; s.n++;
            a.log.stats[key] = s;
        }
        if (a.batch.length >= 128 || Date.now() - a.flushAt >= 4000) this.flush();
    }

    activeDurationMs() {
        const a = this.active;
        if (!a) return 0;
        return a.activeMs + (a.log.status === 'RECORDING' ? Math.max(0, Date.now() - a.activeSince) : 0);
    }

    flush() {
        const a = this.active;
        if (!a || !a.batch.length) return;
        const rows = a.batch.slice();
        try {
            fs.appendFileSync(this._file(a.log.id), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
            a.batch.splice(0, rows.length); a.flushAt = Date.now();
        }
        catch (e) { if (this.log) this.log.warn('VLogMaster buffer flush: ' + e.message); }
    }

    stop(reason) {
        const a = this.active;
        if (!a) return false;
        if (this.flushTimer) clearInterval(this.flushTimer);
        this.flushTimer = null; this.flush();
        const end = Date.now(), duration = Math.max(0, end - a.log.startedAt);
        const activeDuration = a.activeMs + (a.log.status === 'RECORDING' ? Math.max(0, end - a.activeSince) : 0);
        a.log.endedAt = end; a.log.durationMs = duration; a.log.activeDurationMs = activeDuration; a.log.status = reason || 'SAVED';
        a.log.actualHz = activeDuration > 0 ? Math.round(a.log.sampleCount * 1000 / activeDuration * 100) / 100 : 0;
        a.log.channelHz = Object.create(null);
        Object.keys(a.log.counts).forEach((k) => { a.log.channelHz[k] = activeDuration > 0 ? Math.round(a.log.counts[k] * 1000 / activeDuration * 100) / 100 : 0; });
        Object.keys(a.log.stats).forEach((k) => { const s = a.log.stats[k]; s.avg = s.n ? s.sum / s.n : null; delete s.sum; });
        this.active = null; this._saveIndex(); return true;
    }

    pause(paused) {
        const a = this.active;
        if (!a || (paused && a.log.status === 'PAUSED') || (!paused && a.log.status === 'RECORDING')) return false;
        const now = Date.now();
        if (paused) { a.activeMs += Math.max(0, now - a.activeSince); a.activeSince = 0; a.log.status = 'PAUSED'; }
        else { a.activeSince = now; a.log.status = 'RECORDING'; }
        this._saveIndex(); return true;
    }

    samples(id) {
        const file = this._file(id), out = [];
        try {
            const content = fs.readFileSync(file, 'utf8').split(/\r?\n/);
            for (let i = 0; i < content.length; i++) { if (!content[i]) continue; try { out.push(JSON.parse(content[i])); } catch (e) { /* skip an incomplete final line */ } }
        } catch (e) { /* empty or missing log */ }
        return out;
    }

    rename(id, name) {
        const log = this.get(id), next = String(name || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 40);
        if (!log || !next) return false;
        log.name = next; this._saveIndex(); return true;
    }
    remove(id) {
        const log = this.get(id); if (!log || (this.active && this.active.log.id === id)) return false;
        try { fs.unlinkSync(this._file(id)); } catch (e) { if (e.code !== 'ENOENT') return false; }
        this.logs = this.logs.filter((x) => x.id !== id); this._saveIndex(); return true;
    }
    export(id, format) {
        const log = this.get(id); if (!log) return null;
        const rows = this.samples(id), base = path.join(this.root, id + '.' + (format === 'json' ? 'json' : 'csv'));
        try {
            if (format === 'json') fs.writeFileSync(base, JSON.stringify({ metadata: log, samples: rows }, null, 2));
            else {
                const quote = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
                const lines = ['timestamp_ms,signal,raw_value,decoded_value,unit,source'];
                rows.forEach((r) => lines.push([r.t, r.key, r.raw, r.value, r.unit, r.source].map(quote).join(',')));
                fs.writeFileSync(base, lines.join('\r\n') + '\r\n');
            }
            return base;
        } catch (e) { if (this.log) this.log.warn('VLogMaster export: ' + e.message); return null; }
    }
}

module.exports = { RecordingStore };
