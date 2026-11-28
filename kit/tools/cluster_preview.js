'use strict';
/**
 * cluster_preview.js - watch a cluster (cluster-render) app's design live in the browser.
 *
 *   node kit/tools/cluster_preview.js vclusters [--port 8078]
 *
 * The app's HUD_CLUSTER_SOCKET is pointed at a fake cluster-render here (a Windows named
 * pipe), which relays every layer/uniform/frame message to the page over a WebSocket.
 * The page composites the panel (1920x720) in WebGL: image layers as textures, effect
 * layers as GLSL ES 1.00 - the same shader source the app sends to the car's daemon.
 * A save under apps/<id>/ rebuilds dist/<id> and restarts the app.
 */
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, fork, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const PORT = Number(opt('--port', 8078));
const APP = args[0];
if (!APP) { console.log('usage: node kit/tools/cluster_preview.js <app> [--port 8078]'); process.exit(1); }
const PIPE = '\\\\.\\pipe\\cluster-render-preview';
const JSON_T = 0x4a, FRAME_T = 0x46;

const clients = new Set();          // ws sockets
// replay state for late-joining pages, per pipe conn: structural ops in order,
// latest value per uniform, latest frame per layer ref. An append-only log loses
// layer declarations to needle-angle uniform spam (thousands per minute), so a
// late joiner used to get 0 layers and a black canvas.
const replay = new Map();           // conn -> { ops:[], uniforms:Map, frames:Map }
function replayFor(conn) {
    let R = replay.get(conn);
    if (!R) { R = { ops: [], uniforms: new Map(), frames: new Map() }; replay.set(conn, R); }
    return R;
}
let clientSeq = 0;

/* ---------- the page ---------- */
const PAGE = `<!doctype html><meta charset="utf-8"><title>Cluster preview</title>
<style>
  html,body{margin:0;height:100%;background:#181818;display:flex;flex-direction:column;align-items:center;justify-content:center;font:13px sans-serif;color:#aaa}
  #wrap{position:relative;width:96vw;max-width:1600px}
  canvas{width:100%;aspect-ratio:1920/720;background:#000;box-shadow:0 0 40px #000;display:block}
  #ref{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;display:none;pointer-events:none}
  #refSplit{width:96vw;max-width:1600px;aspect-ratio:1920/720;object-fit:fill;background:#000;display:none;margin-top:10px}
  #bar{margin-top:8px;display:flex;gap:16px;align-items:center}
  #fps{color:#666}
  select,input[type=range]{accent-color:#888}
  button{background:#1c2027;color:#cfd3da;border:1px solid #3a4048;border-radius:4px;padding:3px 10px;font:inherit;cursor:pointer}
  button:hover{background:#262b33}button.dm.on{border-color:#e33}
</style>
<div id="wrap"><canvas id="cv" width="1920" height="720"></canvas><img id="ref" src="/ref.jpg"></div>
<img id="refSplit" src="/ref.jpg">
<div id="bar"><span id="st">connecting…</span><span id="fps"></span>
  <label>view <select id="mode"><option value="live">live</option><option value="split">split</option><option value="overlay">overlay</option></select></label>
  <label>opacity <input id="op" type="range" min="0" max="100" value="50" style="width:90px"></label>
  <span style="margin-left:24px">drive</span>
  <button class="dm" data-m="COMFORT">COMFORT</button>
  <button class="dm" data-m="SPORT">SPORT</button>
  <button class="dm" data-m="SPORT_PLUS">SPORT+</button>
  <button id="demo" style="margin-left:24px">&#9654; DEMO DRIVE</button>
  <button id="demostop">&#9632; STOP</button>
  <button id="manual" style="margin-left:24px">MANUAL</button>
  <button id="gas" style="width:120px;background:#1c5a24">&#9207; THROTTLE</button>
  <button id="brake" style="width:100px;background:#6a1a1a">&#9209; BRAKE</button>
</div>
<script>
const ctl = (p) => fetch('/ctl/' + p, { method: 'POST' });
document.querySelectorAll('button.dm').forEach((b) => { b.onclick = () => ctl('mode/' + b.dataset.m); });
document.getElementById('demo').onclick = () => ctl('demo/on');
document.getElementById('demostop').onclick = () => ctl('demo/off');
let manOn = false;
const manBtn = document.getElementById('manual');
manBtn.onclick = () => { manOn = !manOn; manBtn.style.outline = manOn ? '2px solid #5cf' : 'none'; ctl('manual/' + (manOn ? 'on' : 'off')); };
// press-and-hold pedals: pointer or W/ArrowUp (gas), S/ArrowDown (brake)
const hold = (id, op) => {
    const b = document.getElementById(id);
    const dn = (e) => { e.preventDefault(); b.style.filter = 'brightness(1.7)'; ctl(op + '/100'); };
    const up = () => { b.style.filter = ''; ctl(op + '/0'); };
    b.onpointerdown = dn; b.onpointerup = up; b.onpointerleave = up; b.onpointercancel = up;
};
hold('gas', 'gas'); hold('brake', 'brake');
const KEYS = { ArrowUp: 'gas', w: 'gas', W: 'gas', ArrowDown: 'brake', s: 'brake', S: 'brake' };
const held = {};
addEventListener('keydown', (e) => {
    const op = KEYS[e.key];
    if (!op || held[op] || e.repeat) return;
    held[op] = true;
    document.getElementById(op).style.filter = 'brightness(1.7)';
    ctl(op + '/100');
});
addEventListener('keyup', (e) => {
    const op = KEYS[e.key];
    if (!op) return;
    held[op] = false;
    document.getElementById(op).style.filter = '';
    ctl(op + '/0');
});
const refImg = document.getElementById('ref'), refSplit = document.getElementById('refSplit');
document.getElementById('mode').onchange = (e) => {
    const m = e.target.value;
    refImg.style.display = m === 'overlay' ? 'block' : 'none';
    refSplit.style.display = m === 'split' ? 'block' : 'none';
};
document.getElementById('op').oninput = (e) => { refImg.style.opacity = e.target.value / 100; };
refImg.style.opacity = 0.5;
const cv = document.getElementById('cv'), gl = cv.getContext('webgl', {alpha:false, antialias:false, premultipliedAlpha:false});
const SHOT = /[?&]shot/.test(location.search);   // only the headless shot page posts snapshots; other open tabs must not overwrite shot.png
const st = document.getElementById('st'), fpsEl = document.getElementById('fps');
const layers = new Map();           // (conn:ref) -> layer
let dirty = true, orderDirty = true, drawList = [], needsAnim = false;
let fpsAt = performance.now(), fpsN = 0, shotT = 0;
const programInfo = new WeakMap();
function uniform(prog, name) {
    const cache = programInfo.get(prog).uniforms;
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name));
    return cache.get(name);
}

const VS = 'attribute vec2 a_uv;varying vec2 v_uv;uniform vec4 u_rect;' +
  'void main(){v_uv=a_uv;vec2 p=u_rect.xy+a_uv*u_rect.zw;' +
  'gl_Position=vec4(p.x/960.0-1.0,1.0-p.y/360.0,0.0,1.0);}';
const IMG_FS = 'precision mediump float;varying vec2 v_uv;uniform sampler2D u_img;uniform float u_opacity;' +
  'void main(){vec4 c=texture2D(u_img,v_uv);gl_FragColor=vec4(c.rgb,c.a*u_opacity);}';

function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s), src); return null; }
    return s;
}
function program(fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(p)); return null; }
    programInfo.set(p, { uv: gl.getAttribLocation(p, 'a_uv'), uniforms: new Map() });
    return p;
}
const quad = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW);
const imgProg = program(IMG_FS);

function texture() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
}

function onOp(conn, m) {
    if (['layer', 'asset', 'set', 'drop', 'hello', 'bye'].includes(m.op)) orderDirty = true;
    if (m.op === 'layer' || m.op === 'asset') {
        const ref = conn + ':' + m.ref;
        const L = { kind: m.kind || m.op, target: m.target || 'panel', x: m.x || 0, y: m.y || 0, w: m.w || 0, h: m.h || 0,
            z: m.z || 0, klass: m.class || 'content', visible: m.visible !== 0, opacity: (m.opacity === undefined ? 255 : m.opacity) / 255,
            uniforms: {}, binds: {}, tex: null, prog: null, iw: m.iw || m.w || 0, ih: m.ih || m.h || 0,
            bpp: m.format === 'r8' ? 1 : 4, time: !!m.time, t0: performance.now() };
        if (L.kind === 'effect' && m.fs) { L.fs = m.fs; L.vs = m.vs; L.prog = program(m.fs); }
        if (L.kind === 'image' || L.kind === 'asset') L.tex = texture();
        layers.set(ref, L);
    } else if (m.op === 'uniform') {
        const L = layers.get(conn + ':' + m.ref);
        if (L) L.uniforms[m.name] = m.v.split(' ').map(Number);
    } else if (m.op === 'bind') {
        const L = layers.get(conn + ':' + m.ref);
        if (L) L.binds[m.sampler] = conn + ':' + m.asset;
    } else if (m.op === 'set') {
        const L = layers.get(conn + ':' + m.ref);
        if (L) {
            ['x','y','w','h','z'].forEach((k) => { if (m[k] !== undefined) L[k] = m[k]; });
            if (m.visible !== undefined) L.visible = m.visible !== 0;
            if (m.opacity !== undefined) L.opacity = m.opacity / 255;
            if (m.class !== undefined) L.klass = m.class;
        }
    } else if (m.op === 'drop') {
        const ref = conn + ':' + m.ref, L = layers.get(ref);
        if (L) { if (L.tex) gl.deleteTexture(L.tex); if (L.prog) gl.deleteProgram(L.prog); layers.delete(ref); }
    } else if (m.op === 'hello' || m.op === 'bye') {
        const pfx = conn + ':';
        [...layers.keys()].filter((k) => k.startsWith(pfx)).forEach((ref) => {
            const L = layers.get(ref);
            if (L.tex) gl.deleteTexture(L.tex);
            if (L.prog) gl.deleteProgram(L.prog);
            layers.delete(ref);
        });
    }
    dirty = true;
}

function onFrame(conn, b) {
    /* ref u32 | id u64 | nrects u16 | rects(x,y,w,h u16) | px */
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const ref = dv.getUint32(0, true), n = dv.getUint16(12, true);
    const L = layers.get(conn + ':' + ref);
    if (!L || !L.tex) return;
    let off = 14 + n * 8;
    gl.bindTexture(gl.TEXTURE_2D, L.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (!n) {                            // whole image
        const px = new Uint8Array(b.buffer, b.byteOffset + off, b.byteLength - off);
        const fmt = L.bpp === 1 ? gl.LUMINANCE : gl.RGBA;
        gl.texImage2D(gl.TEXTURE_2D, 0, fmt, L.iw, L.ih, 0, fmt, gl.UNSIGNED_BYTE, px);
    } else {
        for (let i = 0; i < n; i++) {
            const x = dv.getUint16(14 + i * 8, true), y = dv.getUint16(16 + i * 8, true);
            const w = dv.getUint16(18 + i * 8, true), h = dv.getUint16(20 + i * 8, true);
            const sz = w * h * L.bpp;
            const px = new Uint8Array(b.buffer, b.byteOffset + off, sz);
            const fmt = L.bpp === 1 ? gl.LUMINANCE : gl.RGBA;
            gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, fmt, gl.UNSIGNED_BYTE, px);
            off += sz;
        }
    }
    dirty = true;
}

function drawLayer(L, dt) {
    if (!L.visible || L.w <= 0 || L.h <= 0) return;
    const isImg = L.kind === 'image' || L.kind === 'asset';
    const prog = isImg ? imgProg : L.prog;
    if (!prog) return;
    if (!isImg && L.kind !== 'effect') return;   // video/mesh: no preview
    gl.useProgram(prog);
    const au = programInfo.get(prog).uv;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(au);
    gl.vertexAttribPointer(au, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(uniform(prog, 'u_rect'), L.x, L.y, L.w, L.h);
    let unit = 0;
    if (isImg) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, L.tex);
        gl.uniform1i(uniform(prog, 'u_img'), unit++);
        gl.uniform1f(uniform(prog, 'u_opacity'), L.opacity);
    } else {
        for (const name in L.binds) {
            const A = layers.get(L.binds[name]);
            if (!A || !A.tex) continue;
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, A.tex);
            gl.uniform1i(uniform(prog, name), unit++);
        }
        const sz = uniform(prog, 'u_size');
        if (sz) gl.uniform2f(sz, L.w, L.h);
        const op = uniform(prog, 'u_opacity');
        if (op) gl.uniform1f(op, L.opacity);
        for (const name in L.uniforms) {
            const loc = uniform(prog, name), v = L.uniforms[name];
            if (!loc || !v.length) continue;
            (v.length === 16 ? gl.uniformMatrix4fv(loc, false, v)
                : [gl.uniform1f, gl.uniform2f, gl.uniform3f, gl.uniform4f][v.length - 1]).call(gl, loc, ...v);
        }
        if (L.time) {
            const t = uniform(prog, 'u_time');
            if (t) gl.uniform1f(t, dt / 1000);
        }
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function frame(t) {
    requestAnimationFrame(frame);
    if (orderDirty) {
        drawList = [...layers.values()].filter(L => L.visible && (L.kind === 'image' || L.kind === 'effect')).sort((a, b) =>
            (a.klass === 'overlay' ? 1 : 0) - (b.klass === 'overlay' ? 1 : 0) || a.z - b.z);
        needsAnim = drawList.some(L => L.time);
        orderDirty = false;
    }
    if (!dirty && !needsAnim) { reportFps(t); return; }
    dirty = false;
    gl.viewport(0, 0, 1920, 720);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (const L of drawList) drawLayer(L, t - L.t0);
    if (SHOT && t - shotT > 2000) { shotT = t; try { fetch('/shot?hud=1', { method: 'POST', body: cv.toDataURL('image/png') }).catch(() => {}); } catch (e) {} }
    fpsN++;
    reportFps(t);
}
function reportFps(t) {
    if (t - fpsAt >= 1000) {
        fpsEl.textContent = (fpsN * 1000 / (t - fpsAt)).toFixed(0) + ' fps · ' + layers.size + ' layers';
        fpsN = 0;
        fpsAt = t;
    }
}
requestAnimationFrame(frame);

function clearLayers() {    // a dead conn never says 'bye': on reconnect its layers are ghosts over the new ones
    for (const L of layers.values()) { if (L.tex) gl.deleteTexture(L.tex); if (L.prog) gl.deleteProgram(L.prog); }
    layers.clear();
    orderDirty = dirty = true;
}
function connect() {
    const ws = new WebSocket('ws://' + location.host + '/ws');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { clearLayers(); st.textContent = 'connected'; };
    ws.onclose = () => { clearLayers(); st.textContent = 'disconnected — retrying…'; setTimeout(connect, 700); };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
            const m = JSON.parse(e.data);
            if (m.t === 'op') onOp(m.conn, m.op);
            else if (m.t === 'state') st.textContent = m.s;
        } else {
            const b = new Uint8Array(e.data);
            const conn = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
            onFrame(conn, b.slice(4));
        }
    };
}
connect();
</script>`;

/* ---------- minimal ws (RFC 6455) ---------- */
function wsAccept(sock, key) {
    const h = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + h + '\r\n\r\n');
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
            const len0 = buf[1] & 0x7f;
            const hl = 2 + (len0 === 126 ? 2 : len0 === 127 ? 8 : 0) + 4;
            if (buf.length < hl) return;
            const paylen = len0 === 126 ? buf.readUInt16BE(2) : len0 === 127 ? Number(buf.readBigUInt64BE(2)) : len0;
            if (buf.length < hl + paylen) return;
            const mask = buf.slice(hl - 4, hl), body = buf.slice(hl, hl + paylen);
            for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
            buf = buf.slice(hl + paylen);
        }
    });
}
function wsSend(sock, data, binary) {
    const p = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const len = p.length;
    let head;
    if (len < 126) head = Buffer.from([binary ? 0x82 : 0x81, len]);
    else if (len < 65536) head = Buffer.from([binary ? 0x82 : 0x81, 126, len >> 8, len & 255]);
    else {
        head = Buffer.alloc(10);
        head[0] = binary ? 0x82 : 0x81;
        head[1] = 127;
        head.writeUInt32BE(0, 2);
        head.writeUInt32BE(len, 6);
    }
    sock.write(Buffer.concat([head, p]));
}
function broadcast(data, binary, conn) {
    if (conn !== undefined) {
        const R = replayFor(conn);
        if (binary) {
            // per layer ref: newest full upload + dirty-rect tail after it, so a late
            // joiner can rebuild the texture (texSubImage2D needs the full alloc first)
            const ref = data.readUInt32LE(4);
            let F = R.frames.get(ref);
            if (!F) R.frames.set(ref, F = { full: null, tail: [] });
            const buf = Buffer.from(data);
            if (data.readUInt16LE(16) === 0) { F.full = buf; F.tail.length = 0; }
            else F.tail.push(buf);   // every dirty rect matters: dropping any leaves the joiner's texture torn
        } else if (data.op && data.op.op === 'uniform') {
            R.uniforms.set(data.op.ref + ':' + data.op.name, JSON.stringify(data));
        } else {
            if (data.op && data.op.op === 'drop') {                 // forget the dropped layer's queued state
                const ref = data.op.ref;
                for (const k of [...R.uniforms.keys()]) if (k.startsWith(ref + ':')) R.uniforms.delete(k);
                R.frames.delete(ref);
            }
            R.ops.push(JSON.stringify(data));
            if (R.ops.length > 4000) R.ops = R.ops.slice(-2000);
        }
    }
    const msg = binary ? data : JSON.stringify(data);
    for (const s of clients) { try { wsSend(s, msg, binary); } catch (e) { /* gone */ } }
}

/* ---------- fake cluster-render on a named pipe ---------- */
const pipe = net.createServer((sock) => {
    const conn = ++clientSeq;
    console.log('[pipe] conn ' + conn + ' from ' + (sock.remoteAddress || 'local'));
    let inbuf = Buffer.alloc(0);
    const sendJson = (o) => sock.write((() => { const b = Buffer.from(JSON.stringify(o)); const m = Buffer.alloc(5 + b.length); m.writeUInt32LE(b.length + 1, 0); m[4] = JSON_T; b.copy(m, 5); return m; })());
    sock.on('data', (d) => {
        inbuf = inbuf.length ? Buffer.concat([inbuf, d]) : d;
        while (inbuf.length >= 5) {
            const len = inbuf.readUInt32LE(0);
            if (len < 1 || len > 64 * 1024 * 1024 || inbuf.length < 4 + len) break;
            const type = inbuf[4], body = inbuf.slice(5, 4 + len);
            inbuf = inbuf.slice(4 + len);
            if (type === JSON_T) {
                let ev = null;
                try { ev = JSON.parse(body.toString('utf8')); } catch (e) { continue; }
                if (ev.op === 'hello') {
                    replay.delete(conn);                               // this conn's replay restarts
                    sendJson({ ev: 'hello', backend: 'pc-preview', targets: 'panel hud' });
                } else if (ev.op === 'status') sendJson({ ev: 'status', text: 'target panel: slot 0x203 scene 0x10004f8 1920x720\ntarget hud: slot 0x204 scene 0x10004f9 1920x720' });
                broadcast({ t: 'op', conn, op: ev }, false, conn);
            } else if (type === FRAME_T) {
                const head = Buffer.alloc(4);
                head.writeUInt32LE(conn, 0);
                broadcast(Buffer.concat([head, body]), true, conn);
            }
        }
    });
    sock.on('close', () => {
        replay.delete(conn);
        broadcast({ t: 'op', conn, op: { op: 'bye' } }, false);
    });
    sock.on('error', () => {});
});
pipe.on('error', (e) => { console.error('pipe:', e.message); process.exit(1); });
pipe.listen(PIPE, () => console.log('fake cluster-render on ' + PIPE));

/* ---------- http + ws ---------- */
const REF_IMG = (() => {                       // the design reference for overlay/split compare
    try {
        const dir = path.join(ROOT, 'apps', APP, 'Designs');
        const f = fs.readdirSync(dir).find((n) => /\.(jpe?g|png|webp)$/i.test(n));
        return f ? fs.readFileSync(path.join(dir, f)) : null;
    } catch (e) { return null; }
})();
const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/shot')) {  // the page posts a rolling canvas snapshot for headless debugging
        const ok = req.url.includes('hud=1');                    // only the ?shot headless page may write shot.png; stale open tabs are ignored
        let b = '';
        req.on('data', (c) => { if (ok) b += c; });
        req.on('end', () => {
            const m = /^data:image\/png;base64,(.+)$/.exec(b || '');
            if (m) try { fs.writeFileSync(path.join(ROOT, 'preview', 'cluster_preview', APP, 'shot.png'), Buffer.from(m[1], 'base64')); } catch (e) {}
            res.writeHead(204); res.end();
        });
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/ctl/')) {
        const op = decodeURIComponent(req.url.slice(5));
        if (op.startsWith('mode/')) {
            curDrive = op.slice(5);
            if (!driving) sendSig({ t: 'sig', mode: 'manual', v: parked() });   // parked: one frame carries the new mode to FES
        } else if (op === 'demo/on') { driving = true; manual = false; animT0 = Date.now(); }
        else if (op === 'demo/off') { driving = false; sendSig({ t: 'sig', mode: 'manual', v: parked() }); }
        else if (op === 'manual/on') { manual = true; driving = true; simReset(); }
        else if (op === 'manual/off') { manual = false; driving = false; simReset(); sendSig({ t: 'sig', mode: 'manual', v: parked() }); }
        else if (op.startsWith('gas/')) { const v = Number(op.slice(4)); if (isFinite(v)) SIM.pedal = Math.min(1, Math.max(0, v / 100)); }
        else if (op.startsWith('brake/')) { const v = Number(op.slice(6)); if (isFinite(v)) SIM.brake = Math.min(1, Math.max(0, v / 100)); }
        else if (op.startsWith('tyre/')) {
            const c = op.slice(5).split('/');
            if (c.length === 2 && /^(FL|FR|RL|RR)$/.test(c[0])) {
                if (c[1] === 'auto') delete tyreOver[c[0]]; else tyreOver[c[0]] = Number(c[1]);
                sendSig({ t: 'sig', mode: 'manual', v: driving ? driveFrame((Date.now() - animT0) / 1000) : parked() });
            }
        }
        res.writeHead(204); res.end(); return;
    }
    if (req.url === '/ref.jpg') {
        if (!REF_IMG) { res.writeHead(404); res.end('no Designs/ image'); return; }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
        res.end(REF_IMG);
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
});
server.on('upgrade', (req, sock) => {
    if (!req.url.startsWith('/ws')) { sock.destroy(); return; }
    const key = (req.headers['sec-websocket-key'] || '').trim();
    if (!key) { sock.destroy(); return; }
    wsAccept(sock, key);
    clients.add(sock);
    for (const R of replay.values()) {
        for (const s of R.ops) wsSend(sock, s, false);
        for (const s of R.uniforms.values()) wsSend(sock, s, false);
        for (const F of R.frames.values()) {
            if (F.full) wsSend(sock, F.full, true);
            for (const b of F.tail) wsSend(sock, b, true);
        }
    }
    sock.on('close', () => clients.delete(sock));
    sock.on('error', () => clients.delete(sock));
});
server.listen(PORT, '127.0.0.1', () => console.log('cluster preview: http://localhost:' + PORT));

/* ---------- the app: build + hu-stub child ---------- */
let child = null, building = false, wantRestart = false;
function build() {
    const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
        [path.join(ROOT, 'kit', 'tools', 'build.py'), APP, '--preview-only'], { cwd: ROOT });
    if (r.status !== 0) { console.error(String(r.stdout) + String(r.stderr)); return false; }
    console.log('[build] ok');
    return true;
}
function startApp() {
    const stage = path.join(ROOT, 'dist', APP);
    const data = path.join(ROOT, 'preview', 'cluster_preview', APP);
    fs.mkdirSync(data, { recursive: true });
    const env = Object.assign({}, process.env, {
        HUD_CLUSTER_SOCKET: PIPE,
        MGU_RENDERD_FILE: path.join(data, 'gpu.bin'),
        // the canned drive feeds these as real SOME/IP values, so the stub has to advertise them
        MGU_EMU_PROVIDES: [
            'de.bmw.infotainment.vehicle.CDS',            // rpm, coolant/oil temps
            'de.bmw.infotainment.vehicle.Vehicle2',       // speed
            'de.bmw.infotainment.vehicle.CDS2',           // g-forces
            'de.bmw.infrastructure.VehicleInformation',   // gear / drive stage
            'de.bmw.infotainment.KombiIF',                // fuel litres + range km
            'de.bmw.infotainment.vehicle.TPMS',           // tyre pressures + temps
            'de.bmw.infrastructure.EnvironmentalInformation',
        ].join(','),
    });
    child = fork(path.join(__dirname, 'hu-stub.js'), [stage, data], { cwd: data, env: { ...env, CLUSTER_PREVIEW_DIRECT_SIGNALS: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', (d) => process.stdout.write('[app] ' + d));
    child.stderr.on('data', (d) => process.stdout.write('[app!] ' + d));
    child.on('message', (m) => { if (m && m.t === 'log') console.log('[app:' + m.l + '] ' + m.s); });
    child.on('message', (m) => { if (m && m.t === 'loaded' && !driving) sendSig({ t: 'sig', mode: 'manual', v: parked() }); });
    child.on('exit', (code, sig) => { console.log('[app] exited code=' + code + ' sig=' + sig); child = null; });
}
function rebuild() {
    if (building) { wantRestart = true; return; }
    building = true;
    if (child) { try { child.kill(); } catch (e) { /* already gone */ } child = null; }
    setTimeout(() => {                    // let the child let the files go (Windows locks dist/ under it)
        if (build()) startApp();
        building = false;
        if (wantRestart) { wantRestart = false; rebuild(); }
    }, 500);
}

rebuild();
let deb = null;
fs.watch(path.join(ROOT, 'apps', APP), { recursive: true }, () => {
    clearTimeout(deb);
    deb = setTimeout(rebuild, 400);
});
console.log('editing apps/' + APP + ' rebuilds live');

/* ---------- a canned drive per drive mode (hu.feed, 20 Hz): idle, pulls through the gears, lift, back
 *  to P. SPORT_PLUS ramps hardest and rev-matches the downshifts; COMFORT/ECO shift early and stay calm.
 *  The cluster reads rpm / speed / gear / temps / torque / fuel from these. ---------- */
const DRIVES = {
    COMFORT: [
        { t: 0,    rpm: 900,  speed: 0,   gear: 'P'  },
        { t: 2.0,  rpm: 950,  speed: 0,   gear: 'P'  },
        { t: 2.6,  rpm: 1100, speed: 0,   gear: 'D1' },
        { t: 6.0,  rpm: 4200, speed: 55,  gear: 'D1' },
        { t: 6.8,  rpm: 2800, speed: 56,  gear: 'D2' },
        { t: 10.5, rpm: 4600, speed: 95,  gear: 'D2' },
        { t: 11.3, rpm: 3000, speed: 96,  gear: 'D3' },
        { t: 15.0, rpm: 3800, speed: 128, gear: 'D3' },
        { t: 15.8, rpm: 3200, speed: 130, gear: 'D4' },
        { t: 19.0, rpm: 2900, speed: 135, gear: 'D4' },
        { t: 22.0, rpm: 2300, speed: 110, gear: 'D4' },
        { t: 24.5, rpm: 1500, speed: 60,  gear: 'D3' },
        { t: 26.0, rpm: 1000, speed: 20,  gear: 'D2' },
        { t: 27.0, rpm: 850,  speed: 0,   gear: 'P'  },
        { t: 29.0, rpm: 850,  speed: 0,   gear: 'P'  },
    ],
    SPORT: [
        { t: 0,    rpm: 900,  speed: 0,   gear: 'P'  },
        { t: 2.0,  rpm: 950,  speed: 0,   gear: 'P'  },
        { t: 2.4,  rpm: 1100, speed: 0,   gear: 'D1' },
        { t: 4.5,  rpm: 6800, speed: 68,  gear: 'D1' },
        { t: 4.9,  rpm: 3700, speed: 66,  gear: 'D2' },
        { t: 7.0,  rpm: 6900, speed: 112, gear: 'D2' },
        { t: 7.4,  rpm: 4100, speed: 110, gear: 'D3' },
        { t: 10.0, rpm: 7000, speed: 160, gear: 'D3' },
        { t: 10.5, rpm: 4400, speed: 158, gear: 'D4' },
        { t: 13.0, rpm: 5700, speed: 195, gear: 'D4' },
        { t: 15.5, rpm: 2400, speed: 150, gear: 'D4' },
        { t: 17.5, rpm: 1500, speed: 85,  gear: 'D3' },
        { t: 19.0, rpm: 900,  speed: 25,  gear: 'D2' },
        { t: 20.0, rpm: 850,  speed: 0,   gear: 'P'  },
        { t: 22.0, rpm: 850,  speed: 0,   gear: 'P'  },
    ],
    SPORT_PLUS: [
        { t: 0,    rpm: 900,  speed: 0,   gear: 'P'  },
        { t: 1.6,  rpm: 1000, speed: 0,   gear: 'P'  },
        { t: 1.9,  rpm: 1200, speed: 0,   gear: 'D1' },
        { t: 3.9,  rpm: 6900, speed: 72,  gear: 'D1' },
        { t: 4.25, rpm: 3900, speed: 70,  gear: 'D2' },
        { t: 6.3,  rpm: 7000, speed: 118, gear: 'D2' },
        { t: 6.65, rpm: 4300, speed: 116, gear: 'D3' },
        { t: 9.0,  rpm: 7100, speed: 168, gear: 'D3' },
        { t: 9.45, rpm: 4600, speed: 166, gear: 'D4' },
        { t: 11.8, rpm: 6300, speed: 198, gear: 'D4' },
        { t: 13.2, rpm: 3500, speed: 165, gear: 'D4' },
        { t: 13.7, rpm: 4200, speed: 160, gear: 'D3' },   // rev-matched downshift
        { t: 15.0, rpm: 3300, speed: 140, gear: 'D3' },
        { t: 15.4, rpm: 3900, speed: 132, gear: 'D2' },   // rev-matched downshift
        { t: 16.5, rpm: 2200, speed: 80,  gear: 'D2' },
        { t: 17.5, rpm: 1100, speed: 25,  gear: 'D1' },
        { t: 18.2, rpm: 850,  speed: 0,   gear: 'P'  },
        { t: 20.0, rpm: 850,  speed: 0,   gear: 'P'  },
    ],
};
DRIVES.ECO = DRIVES.COMFORT;
let curDrive = 'SPORT';        // the mode buttons change this; every frame carries it so FES is (re)sent
let driving = true;            // the canned drive runs until STOP parks it
let animT0 = Date.now();
const tyreOver = {};           // /ctl/tyre/<corner>/<psi> overrides a corner's feed for testing TPMS colours
function driveFrame(now) {
    const K = DRIVES[curDrive] || DRIVES.SPORT;
    const t = now % K[K.length - 1].t;
    let i = K.length - 2;
    while (i > 0 && K[i].t > t) i--;
    const a = K[i], b = K[i + 1];
    const f = Math.min(1, Math.max(0, (t - a.t) / Math.max(0.01, b.t - a.t)));
    const rpm = a.rpm + (b.rpm - a.rpm) * f;
    const speed = a.speed + (b.speed - a.speed) * f;
    const fuelL = Math.max(8, 52 - now * 0.015);  // a slow, gradual drain (~0.9 L/min) so the needle visibly sinks
    // oil warms up like a real engine: cold start ~48 C, asymptoting to ~112 over a few minutes, ±1.5 ripple;
    // coolant follows quicker to ~92
    const oil = 48 + 64 * (1 - Math.exp(-now / 110)) + Math.sin(now * 0.23) * 1.5;
    const coolant = 55 + 37 * (1 - Math.exp(-now / 55)) + Math.sin(now * 0.31) * 0.8;
    return {
        rpm, speed, gear: a.gear,
        gLong: Math.max(-1.2, Math.min(1.2, (b.rpm - a.rpm) / 3000)),
        gLat: Math.sin(now * 0.4) * 0.15,
        coolant, oil, torque: Math.min(680, rpm * 0.09),
        fuelL, rangeKm: Math.round(fuelL * 11.5), ambient: 21.5,
        tyreP: Object.assign({ FL: 29, FR: 29, RL: 35, RR: 33 }, tyreOver), tyreT: { FL: 7, FR: 7, RL: 6, RR: 6 },
        drive: curDrive,
    };
}
const parked = () => Object.assign(driveFrame(0), { rpm: 850, speed: 0, torque: 55, gLong: 0, gLat: 0, oil: 104, coolant: 92, fuelL: 50 });

/* ---------- manual THROTTLE / BRAKE simulator (40 ms steps) ---------- */
const RPK = [0, 115, 77, 51, 41, 31, 24, 20, 16];   // engine rpm per km/h in gears 1-8
const ACC = [0, 26, 20, 15, 11, 9, 7, 6, 5];        // full-throttle km/h per s, gears 1-8
const TOPV = 250;
const PEDAL_PROFILES = {
    COMFORT:    { curve: 1.12, launch: 2200, lockSpeed: 23, response: 6, pull: 1,    shift: 5600 },
    SPORT:      { curve: 0.86, launch: 3400, lockSpeed: 31, response: 9, pull: 1.18, shift: 6400 },
    SPORT_PLUS: { curve: 0.62, launch: 4900, lockSpeed: 40, response: 15, pull: 1.43, shift: 7000 },
};
let manual = false;
const SIM = { pedal: 0, brake: 0, rpm: 850, speed: 0, gear: 1, parked: true, stopT: 0 };
function simReset() { SIM.pedal = SIM.brake = 0; SIM.rpm = 850; SIM.speed = 0; SIM.gear = 1; SIM.parked = true; SIM.stopT = 0; }
function simFrame(dt, now) {
    const S = SIM;
    const profile = PEDAL_PROFILES[curDrive] || PEDAL_PROFILES.COMFORT;
    const demand = Math.pow(S.pedal, profile.curve);
    if (demand > 0 && S.parked) { S.parked = false; S.gear = 1; }

    const shiftRpm = 2400 + (profile.shift - 2400) * demand;
    let wheelRpm = S.speed * RPK[S.gear];
    if (!S.parked && wheelRpm >= shiftRpm && S.gear < 8) {
        S.gear++;
        wheelRpm = S.speed * RPK[S.gear];
        S.rpm = Math.max(850, wheelRpm);
    } else if (S.gear > 1) {
        const lowerRpm = S.speed * RPK[S.gear - 1];
        const kickdownRpm = 1100 + demand * (profile.shift - 4600);
        if (wheelRpm < kickdownRpm && lowerRpm < shiftRpm - 400) {
            S.gear--;
            wheelRpm = lowerRpm;
        }
    }

    // Converter slip fades as the car picks up speed, instead of cutting out at 3 km/h.
    const slip = Math.max(0, 1 - S.speed / profile.lockSpeed);
    const target = Math.min(profile.shift + 200, Math.max(850, wheelRpm) + demand * (200 + profile.launch * slip));
    const response = demand > 0 ? profile.response : 6;
    S.rpm += (target - S.rpm) * (1 - Math.exp(-dt * response));
    let acc = demand * profile.pull * ACC[S.gear] * Math.max(0.15, 1 - S.speed / TOPV) * Math.min(1, S.rpm / 2600)
        - S.brake * 32 - S.speed * 0.012;
    S.speed = Math.max(0, S.speed + acc * dt);
    if (S.speed < 0.3) S.speed = 0;
    if (S.speed === 0 && S.pedal === 0 && S.brake === 0) {
        if ((S.stopT += dt) > 1.2) { S.parked = true; S.gear = 1; }
    } else S.stopT = 0;
    return Object.assign(driveFrame(now), {
        rpm: S.parked ? 850 : S.rpm, speed: S.speed, gear: S.parked ? 'P' : 'D' + S.gear,
        gLong: Math.max(-1.2, Math.min(1.2, acc / 25)), torque: 55 + demand * 620,
    });
}
function sendSig(v) { if (child && child.connected) try { child.send(v); } catch (e) { /* ipc gone */ } }
const FRAME_MS = 1000 / 60;
let lastSignalAt = performance.now(), nextSignalAt = lastSignalAt + FRAME_MS;
function signalTick() {
    const at = performance.now();
    const dt = Math.min(0.05, (at - lastSignalAt) / 1000);
    lastSignalAt = at;
    if (driving) {
        const now = (Date.now() - animT0) / 1000;
        sendSig({ t: 'sig', mode: 'manual', v: manual ? simFrame(dt, now) : driveFrame(now) });
    }
    nextSignalAt += FRAME_MS * Math.max(1, Math.floor((at - nextSignalAt) / FRAME_MS) + 1);
    setTimeout(signalTick, Math.max(1, Math.ceil(nextSignalAt - performance.now())));
}
setTimeout(signalTick, Math.ceil(FRAME_MS));
