// Top Down Heat: Open State — online game server
// Cloudflare Worker + one Durable Object per match room.
// Rooms: br-1, br-2, … (battle royale, up to 16 players) and fr-1, fr-2, … (free roam, up to 16 players).

export const CAP = { br: 16, fr: 16 };
const LOBBY_WAIT = 90000;   // a battle royale starts 90 s after the first player joins (they explore the lobby island meanwhile)
const FULL_WAIT = 5000;     // …or 5 s after the room is full
const BR_FILL = 20;         // empty seats are filled with AI players, so a match always has 20
const BOT0 = 1001;          // AI player ids: 1001, 1002, … (simulated by the host player's phone)
const IDLE_KICK = 20000;    // drop players that send nothing for 20 s
const DONE_HOLD = 8000;     // keep a finished match open 8 s, then free the room

const clean = (s) => String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 14) || 'Player';
const colr = (s) => (/^#[0-9a-f]{3,8}$/i.test(String(s || '')) ? String(s) : '');

export class RoomCore {
  constructor(name, mode, timers, ts) {
    this.name = name; this.mode = mode === 'fr' ? 'fr' : 'br'; this.T = timers; this.ts = [1, 2, 4].includes(ts | 0) ? ts | 0 : 1;   // team size: solo, duo, squad
    this.cl = new Map(); this.next = 1; this.ev = []; this.loop = null;
    this.reset();
  }
  reset() { this.ph = 'lobby'; this.cdEnd = 0; this.alive = new Set(); this.tk = new Set(); this.ev = []; this.seed = 0; this.doneAt = 0; this.bots = new Set(); this.host = 0; this.bs = null; this.bf = null; this.bfresh = false; this.team = new Map(); }
  ready() { let n = 0; for (const c of this.cl.values()) if (c.hi) n++; return n; }
  open() { return this.cl.size < CAP[this.mode] && (this.mode === 'fr' || this.ph === 'lobby'); }
  status() { return { open: this.open(), n: this.cl.size, ph: this.ph, mode: this.mode, ts: this.ts }; }
  cdLeft() { return this.cdEnd ? Math.max(0, Math.ceil((this.cdEnd - Date.now()) / 1000)) : -1; }
  send(c, o) { c.sock.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  list() { const a = []; for (const c of this.cl.values()) if (c.hi) a.push([c.id, c.name, c.c, c.h, c.cap]); return a; }

  join(sock) {
    if (!this.open()) { sock.send('{"t":"full"}'); sock.close(1013, 'room full'); return null; }
    const c = { id: this.next++, sock, hi: false, name: '', c: '', h: '', cap: '', d: null, fresh: false, f: null, last: Date.now(), alive: false, mT: 0, vT: 0, vN: 0 };
    this.cl.set(c.id, c);
    if (!this.loop) this.loop = this.T.every(() => this.tick(), 100);
    return c;
  }

  msg(c, raw) {
    if (!this.cl.has(c.id) || typeof raw !== 'string' || raw.length > 16000) return;
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
        if (!c.hi) return;
        const dmg = Math.max(0, Math.min(260, +m.dmg || 0)), to = m.to | 0, fb = m.fb | 0; if (!dmg) return;
        if (this.mode === 'br' && this.ph !== 'live') return;
        // a player shot an AI player: the host phone runs the AI, so it gets the hit
        if (this.mode === 'br' && this.bots.has(to)) {
          if (!c.alive || !this.alive.has(to)) return; const h = this.cl.get(this.host); if (!h || !h.hi) return;
          this.send(h, { t: 'hit', from: c.id, dmg, a: +m.a || 0, b: to }); return;
        }
        const t = this.cl.get(to); if (!t || t === c || !t.hi) return;
        if (this.mode === 'br') {
          if (!t.alive) return;
          // the host reports a hit from one of its AI players
          if (fb) { if (c.id !== this.host || !this.bots.has(fb) || !this.alive.has(fb)) return; this.send(t, { t: 'hit', from: fb, dmg, a: +m.a || 0 }); return; }
          if (!c.alive) return;
        }
        this.send(t, { t: 'hit', from: c.id, dmg, a: +m.a || 0 });
        return;
      }
      case 'bs': { // AI player states from the host
        if (this.mode !== 'br' || this.ph !== 'live' || c.id !== this.host || !Array.isArray(m.d) || m.d.length > 40) return;
        this.bs = m.d.filter(e => Array.isArray(e) && this.bots.has(e[0] | 0) && Array.isArray(e[1]) && e[1].length <= 16); this.bfresh = true;
        if (Array.isArray(m.f) && m.f.length) this.bf = (this.bf || []).concat(m.f.slice(0, 30)).slice(-40);
        return;
      }
      case 'bdead': { // an AI player was eliminated (decided by the host)
        if (this.mode !== 'br' || this.ph !== 'live' || c.id !== this.host) return;
        const b = m.b | 0; if (!this.bots.has(b) || !this.alive.has(b)) return;
        this.alive.delete(b);
        const by = m.by | 0, okBy = by && by !== b && (this.cl.has(by) || this.bots.has(by)) ? by : 0;
        this.ev.push(['k', b, okBy, m.x | 0, m.y | 0, m.z ? 1 : 0]);
        this.winCheck();
        return;
      }
      case 'dead': {
        if (!c.hi) return;
        if (this.mode === 'br') { if (this.ph !== 'live' || !c.alive) return; c.alive = false; this.alive.delete(c.id); }
        const by = (m.by | 0) && (this.cl.has(m.by | 0) || this.bots.has(m.by | 0)) && (m.by | 0) !== c.id ? m.by | 0 : 0;
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
      case 'msg': { // quick chat and short text messages
        if (!c.hi) return; const now = Date.now(); if (now - c.mT < 1200) return; c.mT = now;
        const x = String(m.x || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 80); if (!x) return;
        for (const o of this.peersFor(c)) this.send(o, { t: 'm', from: c.id, x });
        return;
      }
      case 'rev': { // a teammate finished reviving a knocked player
        if (!c.hi || this.mode !== 'br' || this.ph !== 'live' || !c.alive) return;
        const t = this.cl.get(m.to | 0); if (!t || t === c || !t.alive || this.team.get(t.id) !== this.team.get(c.id)) return;
        this.send(t, { t: 'rev', from: c.id }); return;
      }
      case 'vc': { // push-to-talk voice: short 8 kHz chunks relayed live, never stored
        if (!c.hi || typeof m.a !== 'string' || m.a.length > 3000) return; const now = Date.now();
        if (now - c.vT > 1000) { c.vT = now; c.vN = 0; } if (++c.vN > 16) return;
        const out = JSON.stringify({ t: 'vc', from: c.id, a: m.a, s: m.s | 0 });
        for (const o of this.peersFor(c)) this.send(o, out);
        return;
      }
    }
  }

  // who hears a player: their team in a team battle royale, everyone else otherwise
  peersFor(c) {
    const out = [], team = this.mode === 'br' && this.ph !== 'lobby' && this.ts > 1 ? this.team.get(c.id) : null;
    for (const o of this.cl.values()) if (o !== c && o.hi && (team == null || this.team.get(o.id) === team)) out.push(o);
    return out;
  }

  leave(c) {
    if (!this.cl.has(c.id)) return;
    this.cl.delete(c.id);
    if (c.hi) this.ev.push(['l', c.id]);
    if (this.mode === 'br') {
      if (this.ph === 'live' && c.alive) { c.alive = false; this.alive.delete(c.id); }
      if (this.ph === 'live' && c.id === this.host) { // hand the AI players to another phone
        let nh = 0; for (const o of this.cl.values()) if (o.hi && (!nh || o.id < nh)) nh = o.id;
        this.host = nh; this.bs = null; this.bf = null; if (nh) this.ev.push(['hs', nh]);
      }
      if (this.ph === 'live') this.winCheck();
      else if (this.ph === 'lobby') this.lobbyCheck();
    }
    if (!this.cl.size) { this.reset(); if (this.loop) { this.T.stop(this.loop); this.loop = null; } }
  }

  lobbyCheck() {
    if (this.ph !== 'lobby') return;
    const n = this.ready(), now = Date.now();
    if (n >= CAP.br) this.cdEnd = Math.min(this.cdEnd || Infinity, now + FULL_WAIT);
    else if (n >= 1) { if (!this.cdEnd) this.cdEnd = now + (this.T.wait || LOBBY_WAIT); }
    else this.cdEnd = 0;
    this.ev.push(['cd', this.cdLeft()]);
  }

  start() {
    this.ph = 'live'; this.cdEnd = 0; this.tk.clear();
    this.seed = ((Math.random() * 4294967295) >>> 0) || 7;
    const ids = [];
    for (const c of this.cl.values()) if (c.hi) { c.alive = true; c.d = null; ids.push(c.id); }
    const nb = Math.max(0, (this.T.fill || BR_FILL) - ids.length), bids = [];
    for (let i = 0; i < nb; i++) bids.push(BOT0 + i);
    this.bots = new Set(bids); this.host = Math.min(...ids); this.bs = null; this.bf = null;
    this.alive = new Set(ids.concat(bids)); this.team = new Map(ids.map((id, i) => [id, Math.floor(i / this.ts)]));
    const msg = JSON.stringify({ t: 'start', seed: this.seed, ids, nb, host: this.host, ts: this.ts });
    for (const c of this.cl.values()) if (c.hi) this.send(c, msg);
  }

  winCheck() {
    if (this.ph !== 'live') return;
    let real = 0; for (const id of this.alive) if (!this.bots.has(id)) real++;
    if (this.alive.size > 1 && real > 0) return;   // the match goes on while a real player is still alive
    this.ph = 'done'; this.doneAt = Date.now();
    this.ev.push(['w', this.alive.size === 1 ? [...this.alive][0] : 0]);
  }

  tick() {
    const now = Date.now();
    for (const c of [...this.cl.values()]) if (now - c.last > IDLE_KICK) { c.sock.close(4000, 'idle'); this.leave(c); }
    if (this.mode === 'br') {
      if (this.ph === 'lobby' && this.cdEnd && now >= this.cdEnd) { if (this.ready() >= 1) this.start(); else { this.cdEnd = 0; this.ev.push(['cd', -1]); } }
      if (this.ph === 'done' && now - this.doneAt > DONE_HOLD) { for (const c of [...this.cl.values()]) { c.sock.close(1000, 'match over'); this.leave(c); } return; }
    }
    const s = [];
    for (const c of this.cl.values()) {
      if (!c.hi || !c.d || (!c.fresh && !c.f)) continue;
      s.push(c.f ? [c.id, c.d, c.f] : [c.id, c.d]); c.fresh = false; c.f = null;
    }
    if (this.bs && (this.bfresh || this.bf)) {
      const fx = new Map(); if (this.bf) for (const e of this.bf) if (Array.isArray(e) && Array.isArray(e[1])) fx.set(e[0] | 0, (fx.get(e[0] | 0) || []).concat(e[1]).slice(-12));
      for (const e of this.bs) { const id = e[0] | 0, f = fx.get(id); if (this.alive.has(id)) s.push(f ? [id, e[1], f] : [id, e[1]]); }
      this.bfresh = false; this.bf = null;
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
    const u = new URL(req.url), mode = u.searchParams.get('m') === 'fr' ? 'fr' : 'br', name = u.searchParams.get('room') || mode, ts = +u.searchParams.get('ts') || 1;
    if (!this.core) this.core = new RoomCore(name, mode, { every: (fn, ms) => setInterval(fn, ms), stop: (id) => clearInterval(id) }, ts);
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
      for (const [pre, mode, ts] of [['br', 'br', 1], ['bd', 'br', 2], ['bq', 'br', 4], ['fr', 'fr', 1]]) for (let i = 1; i <= 6; i++) {
        const name = pre + '-' + i, stub = env.ROOMS.get(env.ROOMS.idFromName(name));
        const st = await (await stub.fetch('https://room/status?m=' + mode + '&ts=' + ts + '&room=' + name)).json();
        if (st.n) out[name] = st;
      }
      return new Response(JSON.stringify(out, null, 1), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (u.pathname !== '/play') return new Response('Not found', { status: 404, headers: CORS });
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Connect with a WebSocket', { status: 426, headers: CORS });
    const mode = u.searchParams.get('m') === 'fr' ? 'fr' : 'br', ts = mode === 'br' && [2, 4].includes(+u.searchParams.get('t')) ? +u.searchParams.get('t') : 1, pre = mode === 'fr' ? 'fr' : ts === 2 ? 'bd' : ts === 4 ? 'bq' : 'br';
    for (let i = 1; i <= 60; i++) {
      const name = pre + '-' + i, stub = env.ROOMS.get(env.ROOMS.idFromName(name)), q = '?m=' + mode + '&ts=' + ts + '&room=' + name;
      const st = await (await stub.fetch('https://room/status' + q)).json();
      if (st.open) return stub.fetch(new Request('https://room/ws' + q, req));
    }
    return new Response('All rooms are full', { status: 503, headers: CORS });
  },
};
