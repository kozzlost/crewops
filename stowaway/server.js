/* Stowaway game server: serves the page and syncs rooms over WebSockets.
   The server holds the real game state and sends each phone only what that player may see. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const E = require("./public/engine.js");

const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, "public");
const MAX_ROOMS = 500;
const MAX_PLAYERS = 12;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000; /* forget empty rooms after 6 hours */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; /* no I or O, they read like 1 and 0 */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

/* ---------- static files ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  const rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    res.end(buf);
  });
});

/* ---------- rooms ---------- */
const rooms = new Map(); /* code -> {code, game, players, sockets:Set, last} */

function newCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = ""; for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function seatedIds(room) {
  return Object.keys(room.players).filter(id => room.players[id].seated && room.players[id].name)
    .sort((a, b) => (room.players[a].joinedAt || 0) - (room.players[b].joinedAt || 0));
}
function bankedScores(room) {
  const g = room.game;
  if (!g) return {};
  const sc = Object.assign({}, g.scores || {});
  if (g.phase !== "round") return sc;
  const d = E.deriveRound(g, room.players);
  if (d.stage === "result" && g.scoredKey !== g.roundKey) Object.keys(d.points).forEach(id => { sc[id] = (sc[id] || 0) + d.points[id]; });
  return sc;
}
function blankGame(hostId) { return { phase: "lobby", hostId, laps: 1, round: 0, scores: {} }; }

/* What one player is allowed to see. */
function viewFor(room, pid) {
  const g = room.game;
  const online = Array.from(new Set(Array.from(room.sockets).map(s => s.pid).filter(Boolean)));
  if (!g) return { game: null, players: room.players, online };
  const view = Object.assign({}, g);
  delete view.used; delete view.lastStowaway;
  if (g.phase === "round") {
    const d = E.deriveRound(g, room.players);
    const secret = d.stage === "clues" || d.stage === "vote";
    if (secret && pid !== g.stowawayId) view.stowawayId = E.HIDDEN;
    if (d.stage !== "result" && pid === g.stowawayId) view.word = null;
  } else {
    delete view.word;
  }
  return { game: view, players: room.players, online };
}
function broadcast(room) {
  room.last = Date.now();
  for (const s of room.sockets) send(s, Object.assign({ t: "state", room: room.code, you: s.pid }, viewFor(room, s.pid)));
}
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

/* ---------- input cleaning ---------- */
const str = (v, max) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);
function cleanPlayer(d, prev) {
  d = d && typeof d === "object" ? d : {};
  const clues = Array.isArray(d.clues) ? d.clues.slice(0, 2).map(c => str(c, 24) || null) : [];
  return {
    name: str(d.name, 18) || (prev && prev.name) || "",
    seated: !!d.seated,
    joinedAt: typeof d.joinedAt === "number" ? d.joinedAt : (prev && prev.joinedAt) || Date.now(),
    roundKey: str(d.roundKey, 40),
    clues,
    vote: str(d.vote, 40),
    guess: str(d.guess, 40),
    rev: typeof d.rev === "number" && isFinite(d.rev) ? d.rev : 0, /* the phone's own write counter */
    updatedAt: Date.now()
  };
}

/* ---------- actions ---------- */
function handle(ws, msg) {
  if (!msg || typeof msg.t !== "string") return;
  if (msg.t === "create") {
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: "error", code: "full", message: "The server is full right now. Try again in a few minutes." });
    const code = newCode(); if (!code) return send(ws, { t: "error", code: "full", message: "Couldn't make a room code. Try again." });
    rooms.set(code, { code, game: null, players: {}, sockets: new Set(), last: Date.now() });
    return send(ws, { t: "created", room: code });
  }
  if (msg.t === "hello") {
    const code = str(msg.room, 4); const pid = str(msg.pid, 40);
    const room = code && rooms.get(code.toUpperCase());
    if (!room) return send(ws, { t: "error", code: "no_room", message: "No room with that code. Check the letters, or start a new room." });
    if (!pid || !/^[A-Za-z0-9_-]{6,40}$/.test(pid)) return send(ws, { t: "error", code: "bad_id", message: "This phone's player id is invalid. Reload the page." });
    if (ws.room && ws.room !== room) ws.room.sockets.delete(ws);
    ws.room = room; ws.pid = pid; room.sockets.add(ws);
    return broadcast(room);
  }
  const room = ws.room, pid = ws.pid;
  if (!room || !pid) return send(ws, { t: "error", code: "not_joined", message: "Join a room first." });
  const g = room.game;
  const isHost = !!(g && g.hostId === pid);
  const hostPresent = !!(g && g.hostId && seatedIds(room).includes(g.hostId));
  const mayRun = isHost || !hostPresent; /* nobody is running the game: anyone may */

  switch (msg.t) {
    case "me": {
      const prev = room.players[pid];
      if (!prev && Object.keys(room.players).length >= MAX_PLAYERS) return send(ws, { t: "error", code: "room_full", message: "This room already has " + MAX_PLAYERS + " players." });
      room.players[pid] = cleanPlayer(msg.data, prev);
      break;
    }
    case "unseat": {
      const id = str(msg.id, 40);
      if (!mayRun || !room.players[id]) return;
      room.players[id] = Object.assign({}, room.players[id], { seated: false });
      break;
    }
    case "laps": {
      if (!mayRun) return;
      room.game = Object.assign(g || blankGame(pid), { laps: msg.n === 2 ? 2 : 1 });
      break;
    }
    case "takeHost": {
      room.game = Object.assign(g || blankGame(pid), { hostId: pid });
      break;
    }
    case "deal": {
      if (!mayRun) return;
      const ids = seatedIds(room);
      if (ids.length < 3) return send(ws, { t: "error", code: "few", message: "You need at least 3 players on the platform." });
      const prev = g || blankGame(pid);
      const scores = bankedScores(room);
      const deal = E.dealRound(prev, ids);
      room.game = Object.assign({}, prev, deal, { phase: "round", hostId: pid, laps: prev.laps || 1, roundKey: "r" + Date.now().toString(36) + crypto.randomInt(1e6).toString(36), skipped: [], scores, scoredKey: null });
      break;
    }
    case "lobby": {
      if (!mayRun || !g) return;
      room.game = Object.assign({}, g, { phase: "lobby", scores: bankedScores(room), scoredKey: g.roundKey, hostId: g.hostId || pid });
      break;
    }
    case "skip": {
      const id = str(msg.id, 40);
      if (!mayRun || !g || g.phase !== "round") return;
      room.game = Object.assign({}, g, { skipped: Array.from(new Set((g.skipped || []).concat(id))) });
      break;
    }
    case "resetScores": {
      if (!mayRun || !g) return;
      room.game = Object.assign({}, g, { scores: {}, round: 0, scoredKey: g.roundKey });
      break;
    }
    default: return;
  }
  broadcast(room);
}

/* ---------- sockets ---------- */
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
wss.on("connection", ws => {
  ws.alive = true;
  ws.bucket = { n: 0, at: Date.now() };
  ws.on("pong", () => { ws.alive = true; });
  ws.on("message", raw => {
    const now = Date.now();
    if (now - ws.bucket.at > 5000) ws.bucket = { n: 0, at: now };
    if (++ws.bucket.n > 40) return; /* rate limit: 40 messages per 5 seconds */
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    try { handle(ws, msg); } catch (e) { console.error("handle failed", e); }
  });
  ws.on("close", () => { if (ws.room) { ws.room.sockets.delete(ws); broadcast(ws.room); } });
});

/* Keep connections alive through proxies, drop dead ones, forget idle rooms. */
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) {} }
  const now = Date.now();
  for (const [code, room] of rooms) if (!room.sockets.size && now - room.last > ROOM_IDLE_MS) rooms.delete(code);
}, 25000).unref();

if (require.main === module) server.listen(PORT, () => console.log("Stowaway listening on :" + PORT));
module.exports = { server, rooms };
