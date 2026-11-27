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
let opLog = [];                     // replay for late-joining pages: text JSON or tagged binary
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
</style>
<div id="wrap"><canvas id="cv" width="1920" height="720"></canvas><img id="ref" src="/ref.jpg"></div>
<img id="refSplit" src="/ref.jpg">
<div id="bar"><span id="st">connecting…</span><span id="fps"></span>
  <label>view <select id="mode"><option value="live">live</option><option value="split">split</option><option value="overlay">overlay</option></select></label>
  <label>opacity <input id="op" type="range" min="0" max="100" value="50" style="width:90px"></label>
</div>
<script>
const refImg = document.getElementById('ref'), refSplit = document.getElementById('refSplit');
document.getElementById('mode').onchange = (e) => {
    const m = e.target.value;
    refImg.style.display = m === 'overlay' ? 'block' : 'none';
    refSplit.style.display = m === 'split' ? 'block' : 'none';
};
document.getElementById('op').oninput = (e) => { refImg.style.opacity = e.target.value / 100; };
refImg.style.opacity = 0.5;
const cv = document.getElementById('cv'), gl = cv.getContext('webgl', {alpha:false, antialias:true, premultipliedAlpha:false});
const st = document.getElementById('st'), fpsEl = document.getElementById('fps');
const layers = new Map();           // (conn:ref) -> layer
let dirty = true, framesDrawn = 0, fpsAt = Date.now(), fpsN = 0;

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
    const au = gl.getAttribLocation(prog, 'a_uv');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(au);
    gl.vertexAttribPointer(au, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(gl.getUniformLocation(prog, 'u_rect'), L.x, L.y, L.w, L.h);
    let unit = 0;
    if (isImg) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, L.tex);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_img'), unit++);
        gl.uniform1f(gl.getUniformLocation(prog, 'u_opacity'), L.opacity);
    } else {
        for (const name in L.binds) {
            const A = layers.get(L.binds[name]);
            if (!A || !A.tex) continue;
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, A.tex);
            gl.uniform1i(gl.getUniformLocation(prog, name), unit++);
        }
        const sz = gl.getUniformLocation(prog, 'u_size');
        if (sz) gl.uniform2f(sz, L.w, L.h);
        const op = gl.getUniformLocation(prog, 'u_opacity');
        if (op) gl.uniform1f(op, L.opacity);
        for (const name in L.uniforms) {
            const loc = gl.getUniformLocation(prog, name), v = L.uniforms[name];
            if (!loc || !v.length) continue;
            (v.length === 16 ? gl.uniformMatrix4fv(loc, false, v)
                : [gl.uniform1f, gl.uniform2f, gl.uniform3f, gl.uniform4f][v.length - 1]).call(gl, loc, ...v);
        }
        if (L.time) {
            const t = gl.getUniformLocation(prog, 'u_time');
            if (t) gl.uniform1f(t, dt / 1000);
        }
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function frame(t) {
    requestAnimationFrame(frame);
    const needsAnim = [...layers.values()].some((L) => L.time);
    if (!dirty && !needsAnim) return;
    dirty = false;
    gl.viewport(0, 0, 1920, 720);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const list = [...layers.values()].sort((a, b) =>
        (a.klass === 'overlay' ? 1 : 0) - (b.klass === 'overlay' ? 1 : 0) || a.z - b.z);
    for (const L of list) drawLayer(L, t - L.t0);
    fpsN++;
    const now = Date.now();
    if (now - fpsAt > 1000) { fpsEl.textContent = (fpsN * 1000 / (now - fpsAt)).toFixed(0) + ' fps · ' + layers.size + ' layers'; fpsN = 0; fpsAt = now; }
}
requestAnimationFrame(frame);

function connect() {
    const ws = new WebSocket('ws://' + location.host + '/ws');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => st.textContent = 'connected';
    ws.onclose = () => { st.textContent = 'disconnected — retrying…'; setTimeout(connect, 700); };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
            const m = JSON.parse(e.data);
            if (m.t === 'op') onOp(m.conn, m.op);
            else if (m.t === 'state') st.textContent = m.s;
        } else {
            const b = new Uint8Array(e.data);
            const conn = b[0];
            onFrame(conn, b.slice(1));
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
    if (conn !== undefined) opLog.push({ conn, binary, data: binary ? data : JSON.stringify(data) });
    if (opLog.length > 8000) opLog = opLog.slice(-4000);
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
                    opLog = opLog.filter((e) => e.conn !== conn);      // this conn's replay restarts
                    sendJson({ ev: 'hello', backend: 'pc-preview', targets: 'panel hud' });
                } else if (ev.op === 'status') sendJson({ ev: 'status', text: 'target panel: slot 0x203 scene 0x10004f8 1920x720\ntarget hud: slot 0x204 scene 0x10004f9 1920x720' });
                broadcast({ t: 'op', conn, op: ev }, false, conn);
            } else if (type === FRAME_T) {
                broadcast(Buffer.concat([Buffer.from([conn]), body]), true, conn);
            }
        }
    });
    sock.on('close', () => {
        opLog = opLog.filter((e) => e.conn !== conn);
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
    for (const e of opLog) wsSend(sock, e.data, e.binary);
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
    });
    child = fork(path.join(__dirname, 'hu-stub.js'), [stage, data], { cwd: data, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', (d) => process.stdout.write('[app] ' + d));
    child.stderr.on('data', (d) => process.stdout.write('[app!] ' + d));
    child.on('message', (m) => { if (m && m.t === 'log') console.log('[app:' + m.l + '] ' + m.s); });
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

/* ---------- a canned drive through the stub's manual signals (hu.feed, 20 Hz): idle, pulls through the
 *  gears, lift, back to P. The cluster reads rpm / speed / gear / temps / torque from these. ---------- */
const KEYS = [
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
];
const LOOP = KEYS[KEYS.length - 1].t;
function driveFrame(now) {
    const t = now % LOOP;
    let i = KEYS.length - 2;
    while (i > 0 && KEYS[i].t > t) i--;
    const a = KEYS[i], b = KEYS[i + 1];
    const f = Math.min(1, Math.max(0, (t - a.t) / Math.max(0.01, b.t - a.t)));
    const rpm = a.rpm + (b.rpm - a.rpm) * f;
    const speed = a.speed + (b.speed - a.speed) * f;
    return {
        rpm, speed, gear: a.gear,
        gLong: Math.max(-1.2, Math.min(1.2, (b.rpm - a.rpm) / 3000)),
        gLat: Math.sin(now * 0.4) * 0.15,
        coolant: 92, oil: 104, torque: Math.min(680, rpm * 0.09),
        drive: 'SPORT',
    };
}
const t0 = Date.now();
setInterval(() => {
    if (child) try { child.send({ t: 'sig', mode: 'manual', v: driveFrame((Date.now() - t0) / 1000) }); } catch (e) { /* ipc gone */ }
}, 150);
