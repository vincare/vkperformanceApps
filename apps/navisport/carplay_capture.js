'use strict';

/*
 * Best-effort CarPlay screen capture for NaviSport.
 *
 * It uses the same system capture executable as the existing CarPlay Map Mirror.
 * A BMW app cannot request a second CarPlay video stream; the screen grab may be
 * unavailable (or may no longer contain the projected source) when NaviSport is
 * in front. In those cases this module reports the limitation and draws no map.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { setImage } = require('./kit/record');

const IMAGE_ID = 0x4e53;
const SOURCE_W = 1920;
const SOURCE_H = 720;
const OUT_W = 960;
const OUT_H = 448;
const CROP = { x: 96, y: 22, w: 1152, h: 550 };
const CAPTURE_INTERVAL_MS = 700;
const ERROR_RETRY_MS = 5000;

function finite(n) { return typeof n === 'number' && isFinite(n); }

function mapLike(raw) {
    // Only accept a visibly colourful map area. This avoids feeding NaviSport's
    // own black UI back into itself when the capture sees the foreground app.
    let coloured = 0, sampled = 0;
    for (let gy = 0; gy < 13; gy++) {
        const y = Math.floor(SOURCE_H * (0.12 + gy * 0.055));
        for (let gx = 0; gx < 24; gx++) {
            const x = Math.floor(SOURCE_W * (0.10 + gx * 0.022));
            const i = (y * SOURCE_W + x) * 4;
            const hi = Math.max(raw[i], raw[i + 1], raw[i + 2]);
            const lo = Math.min(raw[i], raw[i + 1], raw[i + 2]);
            if (hi - lo > 28) coloured++;
            sampled++;
        }
    }
    return sampled > 0 && coloured / sampled >= 0.018;
}

function cropToRgba(raw) {
    const out = Buffer.allocUnsafe(OUT_W * OUT_H * 4);
    for (let y = 0; y < OUT_H; y++) {
        const sy = CROP.y + Math.min(CROP.h - 1, Math.floor(y * CROP.h / OUT_H));
        for (let x = 0; x < OUT_W; x++) {
            const sx = CROP.x + Math.min(CROP.w - 1, Math.floor(x * CROP.w / OUT_W));
            const si = (sy * SOURCE_W + sx) * 4;
            const di = (y * OUT_W + x) * 4;
            // winston-grabber writes BGRA on this MGU image path.
            out[di] = raw[si + 2];
            out[di + 1] = raw[si + 1];
            out[di + 2] = raw[si];
            out[di + 3] = 255;
        }
    }
    return out;
}

class CarPlayCapture {
    constructor(dataDir, onChange) {
        this.file = path.join(dataDir, 'navisport-center-frame.rgb');
        this.onChange = onChange || function () {};
        this.timer = null;
        this.busy = false;
        this.child = null;
        this.retryAt = 0;
        this.visible = false;
        this.state = 'waiting';
        this.detail = 'Waiting for a CarPlay map frame';
        this.lastFrameAt = 0;
    }

    start() {
        if (this.visible) return;
        this.visible = true;
        this._tick();
    }

    stop() {
        this.visible = false;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.child && typeof this.child.kill === 'function') {
            try { this.child.kill(); } catch (e) { /* already exited */ }
        }
    }

    snapshot() {
        if (this.state === 'live' && Date.now() - this.lastFrameAt > 2500) {
            return { state: 'stale', detail: 'CarPlay frame stopped updating' };
        }
        return { state: this.state, detail: this.detail };
    }

    _set(state, detail) {
        if (this.state === state && this.detail === detail) return;
        this.state = state;
        this.detail = detail;
        this.onChange();
    }

    _schedule(delay) {
        if (!this.visible || this.timer) return;
        this.timer = setTimeout(() => { this.timer = null; this._tick(); }, delay);
    }

    _tick() {
        if (!this.visible || this.busy) return;
        const now = Date.now();
        if (now < this.retryAt) { this._schedule(this.retryAt - now); return; }

        this.busy = true;
        try { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); } catch (e) { /* try capture anyway */ }
        const env = Object.assign({}, process.env, {
            WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0',
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/wayland'
        });
        this.child = execFile('winston-grabber', ['-s', 'center', '-n', '1', this.file], {
            env: env,
            timeout: 4500,
            maxBuffer: 1024
        }, (err) => {
            this.child = null;
            this.busy = false;
            if (!this.visible) return;
            if (err) {
                this.retryAt = Date.now() + ERROR_RETRY_MS;
                const code = err.code === 'ENOENT' ? 'Capture tool not found'
                    : /EACCES|permission|denied/i.test(String(err.message || err)) ? 'Capture permission unavailable'
                    : 'CarPlay screen capture unavailable';
                this._set('unavailable', code);
                this._schedule(ERROR_RETRY_MS);
                return;
            }
            try {
                const raw = fs.readFileSync(this.file);
                if (raw.length < SOURCE_W * SOURCE_H * 4) throw new Error('Unexpected center-screen frame size');
                if (!mapLike(raw)) {
                    this._set('waiting', 'No CarPlay map frame is visible to the capture service');
                } else {
                    setImage(IMAGE_ID, OUT_W, OUT_H, cropToRgba(raw));
                    this.lastFrameAt = Date.now();
                    this.retryAt = 0;
                    this._set('live', 'Live CarPlay map frame');
                    this.onChange();
                }
            } catch (e) {
                this.retryAt = Date.now() + ERROR_RETRY_MS;
                this._set('unavailable', String(e && e.message || e));
            }
            this._schedule(CAPTURE_INTERVAL_MS);
        });
        this.child.on('error', (err) => {
            if (!this.visible) return;
            this.child = null;
            this.busy = false;
            this.retryAt = Date.now() + ERROR_RETRY_MS;
            this._set('unavailable', /ENOENT/.test(String(err && err.code)) ? 'Capture tool not found' : 'CarPlay screen capture unavailable');
            this._schedule(ERROR_RETRY_MS);
        });
    }
}

module.exports = { CarPlayCapture, IMAGE_ID, OUT_W, OUT_H, mapLike, cropToRgba };
