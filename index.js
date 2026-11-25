// Top Down Heat: Open State — online game server
// Cloudflare Worker + one Durable Object per match room.
// Rooms: br-1, br-2, … (battle royale, up to 16 players) and fr-1, fr-2, … (free roam, up to 16 players).

export const CAP = { br: 16, fr: 16 };
const LOBBY_WAIT = 30000;   // a battle royale starts 30 s after the 2nd player joins
const FULL_WAIT = 5000;     // …or 5 s after the room is full
const IDLE_KICK = 20000;    // drop players that send nothing for 20 s
const DONE_HOLD = 8000;     // keep a finished match open 8 s, then free the room

const clean = (s) => String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 14) || 'Player';
const colr = (s) => (/^#[0-9a-f]{3,8}$/i.test(String(s || '')) ? String(s) : '');

export class RoomCore {
  constructor(name, mode, timers) {
    this.name = name; this.mode = mode === 'fr' ? 'fr' : 'br'; this.T = timers;
    this.cl = new Map(); this.next = 1; this.ev = []; this.loop = null;
    this.reset();
  }
  reset() { this.ph = 'lobby'; this.cdEnd = 0; this.alive = new Set(); this.tk = new Set(); this.ev = []; this.seed = 0; this.doneAt = 0; }
  ready() { let n = 0; for (const c of this.cl.values()) if (c.hi) n++; return n; }
  open() { return this.cl.size < CAP[this.mode] && (this.mode === 'fr' || this.ph === 'lobby'); }
  status() { return { open: this.open(), n: this.cl.size, ph: this.ph, mode: this.mode }; }
  cdLeft() { return this.cdEnd ? Math.max(0, Math.ceil((this.cdEnd - Date.now()) / 1000)) : -1; }
  send(c, o) { c.sock.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  list() { const a = []; for (const c of this.cl.values()) if (c.hi) a.push([c.id, c.name, c.c, c.h, c.cap]); return a; }

  join(sock) {
    if (!this.open()) { sock.send('{"t":"full"}'); sock.close(1013, 'room full'); return null; }
    const c = { id: this.next++, sock, hi: false, name: '', c: '', h: '', cap: '', d: null, fresh: false, f: null, last: Date.now(), alive: false };
    this.cl.set(c.id, c);
    if (!this.loop) this.loop = this.T.every(() => this.tick(), 100);
    return c;
  }

  msg(c, raw) {
    if (!this.cl.has(c.id) || typeof raw !== 'string' || raw.length > 6000) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    c.last = Date.now();
    switch (m.t) {
      case 'hi': {
        if (c.hi) return;
        c.hi = true; c.name = clean(m.n); c.c = colr(m.c) || '#4aa3ff'; c.h = colr(m.h) || '#222222'; c.cap = colr(m.cap);
        this.send(c, { t: 'hello', id: c.id, room: this.name, mode: this.mode, ph: this.ph, cd: this.cdLeft(), pl: this.list() });
        this.ev.push(['j', c.id, c.name, c.c, c.h, c.cap]);
        if (this.mode === 'br') this.lobbyCheck();
        return;
      }
      case 's': {
        if (!c.hi || !Array.isArray(m.d) || m.d.length > 16) return;
        c.d = m.d; c.fresh = true;
        if (Array.isArray(m.f) && m.f.length) c.f = (c.f || []).concat(m.f.slice(0, 18)).slice(-24);
        return;
      }
      case 'hit': {
        const t = this.cl.get(m.to | 0); if (!c.hi || !t || t === c || !t.hi) return;
        if (this.mode === 'br' && (this.ph !== 'live' || !c.alive || !t.alive)) return;
        const dmg = Math.max(0, Math.min(260, +m.dmg || 0)); if (!dmg) return;
        this.send(t, { t: 'hit', from: c.id, dmg, a: +m.a || 0 });
        return;
      }
      case 'dead': {
        if (!c.hi) return;
        if (this.mode === 'br') { if (this.ph !== 'live' || !c.alive) return; c.alive = false; this.alive.delete(c.id); }
        const by = (m.by | 0) && this.cl.has(m.by | 0) && (m.by | 0) !== c.id ? m.by | 0 : 0;
        this.ev.push(['k', c.id, by, m.x | 0, m.y | 0, m.z ? 1 : 0]);
        if (this.mode === 'br') this.winCheck();
        return;
      }
      case 'take': {
        if (this.mode !== 'br' || this.ph !== 'live') return;
        const k = String(m.k || '').slice(0, 48); if (!k || this.tk.has(k)) return;
        this.tk.add(k); this.ev.push(['tk', k]);
        return;
      }
      case 'ping': this.send(c, { t: 'pong', c: +m.c || 0 }); return;
    }
  }

  leave(c) {
    if (!this.cl.has(c.id)) return;
    this.cl.delete(c.id);
    if (c.hi) this.ev.push(['l', c.id]);
    if (this.mode === 'br') {
      if (this.ph === 'live' && c.alive) { c.alive = false; this.alive.delete(c.id); this.winCheck(); }
      else if (this.ph === 'lobby') this.lobbyCheck();
    }
    if (!this.cl.size) { this.reset(); if (this.loop) { this.T.stop(this.loop); this.loop = null; } }
  }

  lobbyCheck() {
    if (this.ph !== 'lobby') return;
    const n = this.ready(), now = Date.now();
    if (n >= CAP.br) this.cdEnd = Math.min(this.cdEnd || Infinity, now + FULL_WAIT);
    else if (n >= 2) { if (!this.cdEnd) this.cdEnd = now + (this.T.wait || LOBBY_WAIT); }
    else this.cdEnd = 0;
    this.ev.push(['cd', this.cdLeft()]);
  }

  start() {
    this.ph = 'live'; this.cdEnd = 0; this.tk.clear();
    this.seed = ((Math.random() * 4294967295) >>> 0) || 7;
    const ids = [];
    for (const c of this.cl.values()) if (c.hi) { c.alive = true; c.d = null; ids.push(c.id); }
    this.alive = new Set(ids);
    const msg = JSON.stringify({ t: 'start', seed: this.seed, ids });
    for (const c of this.cl.values()) if (c.hi) this.send(c, msg);
  }

  winCheck() {
    if (this.ph !== 'live' || this.alive.size > 1) return;
    this.ph = 'done'; this.doneAt = Date.now();
    this.ev.push(['w', [...this.alive][0] || 0]);
  }

  tick() {
    const now = Date.now();
    for (const c of [...this.cl.values()]) if (now - c.last > IDLE_KICK) { c.sock.close(4000, 'idle'); this.leave(c); }
    if (this.mode === 'br') {
      if (this.ph === 'lobby' && this.cdEnd && now >= this.cdEnd) { if (this.ready() >= 2) this.start(); else { this.cdEnd = 0; this.ev.push(['cd', -1]); } }
      if (this.ph === 'done' && now - this.doneAt > DONE_HOLD) { for (const c of [...this.cl.values()]) { c.sock.close(1000, 'match over'); this.leave(c); } return; }
    }
    const s = [];
    for (const c of this.cl.values()) {
      if (!c.hi || !c.d || (!c.fresh && !c.f)) continue;
      s.push(c.f ? [c.id, c.d, c.f] : [c.id, c.d]); c.fresh = false; c.f = null;
    }
    if (!s.length && !this.ev.length) return;
    const msg = JSON.stringify({ t: 'B', s, e: this.ev }); this.ev = [];
    for (const c of this.cl.values()) if (c.hi) this.send(c, msg);
  }
}

// ---------------- Durable Object: one per room ----------------
export class Room {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.core = null; }
  async fetch(req) {
    const u = new URL(req.url), mode = u.searchParams.get('m') === 'fr' ? 'fr' : 'br', name = u.searchParams.get('room') || mode;
    if (!this.core) this.core = new RoomCore(name, mode, { every: (fn, ms) => setInterval(fn, ms), stop: (id) => clearInterval(id) });
    if (u.pathname === '/status') return Response.json(this.core.status());
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    server.accept();
    const sock = {
      send: (s) => { try { server.send(s); } catch (e) {} },
      close: (code, why) => { try { server.close(code, why); } catch (e) {} },
    };
    const c = this.core.join(sock);
    if (c) {
      server.addEventListener('message', (e) => this.core.msg(c, typeof e.data === 'string' ? e.data : ''));
      const bye = () => this.core.leave(c);
      server.addEventListener('close', bye);
      server.addEventListener('error', bye);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}

// ---------------- Worker: picks a room and connects the player ----------------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain; charset=utf-8' };
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/' || u.pathname === '/health') return new Response('Top Down Heat online server is running ✔', { headers: CORS });
    if (u.pathname === '/stats') {
      const out = {};
      for (const mode of ['br', 'fr']) for (let i = 1; i <= 6; i++) {
        const name = mode + '-' + i, stub = env.ROOMS.get(env.ROOMS.idFromName(name));
        const st = await (await stub.fetch('https://room/status?m=' + mode + '&room=' + name)).json();
        if (st.n) out[name] = st;
      }
      return new Response(JSON.stringify(out, null, 1), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (u.pathname !== '/play') return new Response('Not found', { status: 404, headers: CORS });
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Connect with a WebSocket', { status: 426, headers: CORS });
    const mode = u.searchParams.get('m') === 'fr' ? 'fr' : 'br';
    for (let i = 1; i <= 60; i++) {
      const name = mode + '-' + i, stub = env.ROOMS.get(env.ROOMS.idFromName(name));
      const st = await (await stub.fetch('https://room/status?m=' + mode + '&room=' + name)).json();
      if (st.open) return stub.fetch(new Request('https://room/ws?m=' + mode + '&room=' + name, req));
    }
    return new Response('All rooms are full', { status: 503, headers: CORS });
  },
};
