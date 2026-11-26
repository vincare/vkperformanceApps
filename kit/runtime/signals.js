'use strict';
/**
 * signals.js - read live vehicle signals over SOME/IP.
 *
 * Interface configs come from the app's own oap_<uid>/someipInterfaces/,
 * which the installer generates from the app's manifest.json with BMW's own
 * generator (kit/tools/oapgen) against the unit's master catalog
 * /etc/oap/someip/someip-interfaces.json - exactly what MainApp does when it
 * installs an app. So any interface/field listed in app.json "signals" is
 * reachable, not just the trimmed MainApp subset.
 *
 *   const sub = await signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
 *       statusEngineSpeed2: (v) => rpm = v.actualValueRPMEngineCrankshaft,
 *   });
 *   sub.available  // true once the provider (the car) answers
 */
const fs = require('fs');
const path = require('path');

let someip = null;
try { someip = require('someip'); } catch (e) { /* host preview / not installed */ }

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIRS = [path.join(APP_ROOT, 'someipInterfaces'), path.join(__dirname, '..', '..', 'someipdefs')];

// The native binding deadlocks (main thread stuck on a futex) when buildProxy/
// init run inline inside the app's promise chains next to the SDK's own SOME/IP
// traffic. The SDK always calls them from a fresh setImmediate tick, one at a
// time - do the same.
// Two queues, still one call at a time: method calls and the set-up of a proxy for them (proxy, on, onAvailable:
// the diagnostic link) go before the watch() set-ups waiting. An app that watches ten interfaces queues ~40 of
// those at start, and every UDS request used to wait behind all of them. After URGENT_RUN urgent calls in a row a
// set-up waiting goes next: an app with several UDS readers going at once (Live Data's engine page, Redline's
// knock, gearbox and 12 V) can keep the urgent lane busy without a break, and its signals (rpm, gear) would start
// late or never.
const lanes = [[], []];         // [urgent, set-up]
const URGENT_RUN = 4;
// The binding can futex-deadlock a call forever (a subscribe on a field the
// provider never ACKs, a getValue racing SDK traffic). One such job would
// otherwise stall the whole lane - and every interface queued behind it.
// Reject it after a while and carry on; a late resolve is ignored.
const JOB_TIMEOUT = 12000;
let running = false, urgentRun = 0;
function pump() {
    if (running) return;
    const setup = lanes[1].length > 0 && (!lanes[0].length || urgentRun >= URGENT_RUN);
    const job = setup ? lanes[1].shift() : lanes[0].shift();
    if (!job) return;
    urgentRun = setup ? 0 : urgentRun + 1;
    running = true;
    setImmediate(() => {
        let finished = false;
        const finish = () => { if (finished) return; finished = true; running = false; pump(); };
        const timer = setTimeout(() => { job.reject(new Error('someip call timeout')); finish(); }, JOB_TIMEOUT);
        let p;
        try { p = Promise.resolve(job.fn()); } catch (e) { p = Promise.reject(e); }
        p.then(job.resolve, job.reject).then(() => { clearTimeout(timer); finish(); });
    });
}
function nativeTick(fn, urgent) {
    return new Promise((resolve, reject) => { lanes[urgent ? 0 : 1].push({ fn, resolve, reject }); pump(); });
}

function loadConfig(iface) {
    const f = iface.replace(/\./g, '_') + '.json';
    for (const d of DIRS) {
        try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch (e) { /* next */ }
    }
    throw new Error('no SOME/IP config for ' + iface + ' (add it to app.json "signals")');
}

/**
 * Build a proxy and subscribe to fields. handlers = { fieldName: fn(value) }.
 * Also does an initial getValue() for fields that have a getter, so values
 * show up without waiting for the next change.
 * opts.pollMs: also re-read those fields that often while the provider is available - for
 * fields a car may not notify (BMW's x_call only ever reads TPMS, it never subscribes).
 */
async function watch(iface, instance, handlers, log, opts) {
    let stopped = false, pollTimer = null, availabilitySeen = false;
    const res = { iface, available: false, proxy: null, error: null, shutdown: () => Promise.resolve() };
    const fields = Object.keys(handlers || {});
    const diagnostic = (stage, detail) => {
        if (!opts || typeof opts.onDiagnostic !== 'function') return;
        try { opts.onDiagnostic({ iface, instance: String(instance), stage, detail: detail || {} }); }
        catch (e) { if (log) log.warn('diagnostic callback ' + iface + ': ' + e); }
    };
    diagnostic('watch_started', { fields });
    if (!someip) {
        res.error = 'someip native module not available';
        diagnostic('watch_error', { error: res.error });
        return res;
    }
    try {
        diagnostic('config_load_started');
        const cfg = loadConfig(iface);
        const configFields = {};
        fields.forEach((f) => {
            const field = cfg.fields && cfg.fields[f];
            configFields[f] = { declared: !!field, getter: !!(field && field.getter) };
            diagnostic('field_config', { field: f, declared: !!field, getter: !!(field && field.getter) });
        });
        diagnostic('config_loaded', { fields: configFields });
        diagnostic('proxy_build_started');
        const p = await nativeTick(() => someip.buildProxy(cfg, String(instance)).then((px) => px.init().then(() => px)));
        res.proxy = p;
        diagnostic('proxy_ready');
        res.shutdown = () => {
            if (stopped) return Promise.resolve();
            stopped = true;
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            return Promise.resolve().then(() => p.shutdown && p.shutdown()).catch((e) => {
                if (log) log.warn('shutdown ' + iface + ': ' + e);
            });
        };
        const notifyAvailability = (available) => {
            if (stopped) return;
            const changed = !availabilitySeen || res.available !== !!available;
            res.available = !!available;
            availabilitySeen = true;
            if (changed) diagnostic('provider_availability', { available: res.available });
            if (opts && typeof opts.onAvailability === 'function') {
                try { opts.onAvailability(res.available); } catch (e) {
                    if (log) log.warn('availability ' + iface + ': ' + e);
                }
            }
        };
        const fetchAll = () => fields.forEach((f) => {
            if (!stopped && res.available && cfg.fields && cfg.fields[f] && cfg.fields[f].getter) {
                diagnostic('getter_started', { field: f });
                p.getValue(f, 3000).then((v) => {
                    if (!stopped && res.available && handlers[f]) {
                        diagnostic('payload_received', { field: f, source: 'getter' });
                        handlers[f](v, 'getter');
                    }
                }).catch((e) => {
                    const error = String(e && e.message || e);
                    diagnostic('getter_error', { field: f, error });
                    if ((!opts || typeof opts.onDiagnostic !== 'function') && log) log.warn('get ' + iface + '.' + f + ': ' + error);
                });
            }
        });
        // One native call that never resolves (provider stays silent on fields it
        // only exposes via getter - e.g. static TPMS values) must not hold up the
        // rest of the fields or the availability check below. The lane timeout in
        // pump() is the outer safety net; this shorter one keeps startup snappy.
        const CALL_TIMEOUT = 6000;
        const callWithTimeout = (fn, what) => Promise.race([nativeTick(fn),
            new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timeout')), CALL_TIMEOUT))]);
        diagnostic('availability_subscribe_started');
        await callWithTimeout(() => {
            try {
                return Promise.resolve(p.subscribeToAvailability((a) => { notifyAvailability(a); if (a) setImmediate(fetchAll); }))
                    .then((result) => {
                        diagnostic('availability_subscribe_call_resolved');
                        return result;
                    }).catch((e) => {
                        diagnostic('availability_subscribe_error', { error: String(e && e.message || e) });
                        if (log) log.warn('availability subscribe ' + iface + ': ' + (e && e.message || e));
                        return null; /* older binding */
                    });
            } catch (e) {
                diagnostic('availability_subscribe_error', { error: String(e && e.message || e) });
                if (log) log.warn('availability subscribe ' + iface + ': ' + (e && e.message || e));
                return null; /* older binding */
            }
        }, 'availability subscribe');
        for (const f of fields) {
            diagnostic('field_subscribe_started', { field: f });
            try {
                await callWithTimeout(() => p.subscribe({ name: f, onReceive: (v) => {
                    if (stopped || !handlers[f]) return;
                    diagnostic('payload_received', { field: f, source: 'event' });
                    try { handlers[f](v, 'event'); } catch (e) {
                        diagnostic('payload_handler_error', { field: f, error: String(e && e.message || e) });
                        if (log) log.warn(iface + '.' + f + ': ' + e);
                    }
                } }), 'subscribe ' + f);
                diagnostic('field_subscribe_call_resolved', { field: f });
            } catch (e) {
                diagnostic('field_subscribe_error', { field: f, error: String(e && e.message || e) });
                if (log) log.warn('subscribe ' + iface + '.' + f + ': ' + e);
            }
        }
        if (p.isAvailable && p.isAvailable()) { notifyAvailability(true); fetchAll(); }
        else if (!availabilitySeen) notifyAvailability(false);
        if (opts && opts.pollMs) pollTimer = setInterval(() => { if (!stopped && res.available) setImmediate(fetchAll); }, opts.pollMs);
        diagnostic('watch_ready', { available: res.available });
    } catch (e) {
        res.error = String(e);
        diagnostic('watch_error', { error: String(e && e.message || e) });
        if (log) log.warn('signals ' + iface + ': ' + e);
    }
    return res;
}

/** Call a method on an interface instance (e.g. UDS over InternalTasu). */
async function proxy(iface, instance) {
    if (!someip) throw new Error('someip native module not available');
    const cfg = loadConfig(iface);
    return nativeTick(() => someip.buildProxy(cfg, String(instance)).then((p) => p.init().then(() => p)), true);
}

/** Call a method on a proxy from proxy(); params = the method's argument struct. */
function call(p, method, params, timeoutMs) {
    return nativeTick(() => p.callMethod(method, params || {}, timeoutMs || 5000), true);
}

/**
 * Write a field that has a setter (e.g. ConditionBasedServicesLegacy.cBSReset) on a proxy from
 * proxy() or watch().proxy, as BMW's SDK does (_someIpProxy.setValue). value = the field's struct;
 * resolves when the provider took it. Needs "w" in the field's app.json flags, or the installer
 * leaves the setter out of the app's interface config.
 */
function set(p, field, value, timeoutMs) {
    return nativeTick(() => p.setValue(field, value, timeoutMs || 5000));
}

/** Subscribe to a broadcast/event or field on a proxy from proxy(). */
function on(p, name, fn, log) {
    return nativeTick(() => p.subscribe({ name, onReceive: (v) => { try { fn(v); } catch (e) { if (log) log.warn(name + ': ' + e); } } }), true);
}

/** Availability of a proxy's provider; fn(bool) on every change. */
function onAvailable(p, fn) {
    return nativeTick(() => { try { return p.subscribeToAvailability((a) => fn(!!a)); } catch (e) { return null; } }, true)
        .then(() => { if (p.isAvailable && p.isAvailable()) fn(true); });
}

module.exports = { watch, proxy, call, set, on, onAvailable, loadConfig, hasNative: () => !!someip };
