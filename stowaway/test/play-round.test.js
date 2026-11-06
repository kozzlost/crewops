/* End-to-end check: five simulated phones play two full rounds against the real server.
   Run with: npm test */
const assert = require("assert");
const WebSocket = require("ws");
const { server } = require("../server.js");
const E = require("../public/engine.js");

const sleep = ms => new Promise(r => setTimeout(r, ms));
let PORT;

function phone(name) {
  const p = { name, pid: "p_test_" + name.toLowerCase(), state: null, errors: [] };
  p.ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
  p.ws.on("message", raw => {
    const m = JSON.parse(raw);
    if (m.t === "state") p.state = m;
    if (m.t === "created") p.created = m.room;
    if (m.t === "error") p.errors.push(m.code);
  });
  p.send = m => p.ws.send(JSON.stringify(m));
  p.open = new Promise(r => p.ws.on("open", r));
  /* Like the real page: apply your own write locally right away, so the next write builds on it. */
  p.local = null;
  p.me = () => p.local || (p.state && p.state.players[p.pid]) || {};
  p.write = patch => { p.local = Object.assign({}, p.me(), patch); p.send({ t: "me", data: p.local }); };
  return p;
}
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); }
  throw new Error("Timed out waiting for: " + label);
}

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;

  /* static page and engine are served */
  const page = await fetch("http://127.0.0.1:" + PORT + "/").then(r => r.text());
  assert(page.includes("<title>Stowaway</title>"), "index.html served");
  assert((await fetch("http://127.0.0.1:" + PORT + "/engine.js")).ok, "engine.js served");
  assert.strictEqual((await fetch("http://127.0.0.1:" + PORT + "/../server.js")).status, 404, "no path traversal");

  const names = ["Tyler", "Sam", "Priya", "Jo", "Max"];
  const phones = names.map(phone);
  await Promise.all(phones.map(p => p.open));
  const [host] = phones;

  host.send({ t: "create" });
  await until(() => host.created, "room created");
  const room = host.created;
  assert(/^[A-HJ-NP-Z]{4}$/.test(room), "4-letter code without I or O");

  /* a bad code is rejected */
  const stray = phone("Stray"); await stray.open;
  stray.send({ t: "hello", room: "ZZZZ", pid: "p_stray_x1" });
  await until(() => stray.errors.includes("no_room"), "no_room error");
  stray.ws.close();

  for (const [i, p] of phones.entries()) {
    p.send({ t: "hello", room, pid: p.pid });
    await until(() => p.state, p.name + " joined");
    p.write({ name: p.name, seated: true, joinedAt: 1000 + i });
  }
  await until(() => phones.every(p => p.state && Object.keys(p.state.players).length === 5 && p.state.online.length === 5), "everyone seated and online");

  /* only 3+ players can deal; host sets 2 laps and deals */
  host.send({ t: "laps", n: 2 });
  host.send({ t: "deal" });
  await until(() => phones.every(p => p.state.game && p.state.game.phase === "round"), "round dealt");

  for (let round = 1; round <= 2; round++) {
    const views = phones.map(p => p.state.game);
    const stow = phones.find(p => p.state.game.stowawayId === p.pid);
    assert(stow, "exactly one phone learns it is the stowaway");
    assert.strictEqual(phones.filter(p => p.state.game.stowawayId === p.pid).length, 1);
    for (const p of phones) {
      const g = p.state.game;
      assert(!("used" in g) && !("lastStowaway" in g), "word history never sent");
      if (p === stow) assert.strictEqual(g.word, null, "stowaway does not receive the word");
      else { assert(g.word, "passengers receive the word"); assert.strictEqual(g.stowawayId, E.HIDDEN, "passengers do not learn who the stowaway is"); }
    }
    const word = views.find(g => g.word).word;
    const roundKey = host.state.game.roundKey;
    const lineup = host.state.game.lineup;
    assert.notStrictEqual(lineup[0], stow.pid, "stowaway never speaks first");

    /* clues in turn order, two laps */
    for (let lap = 0; lap < 2; lap++) for (const id of lineup) {
      const p = phones.find(x => x.pid === id);
      const clues = (p.me().roundKey === roundKey ? (p.me().clues || []).slice() : []);
      clues[lap] = "clue" + lap + p.name;
      p.write({ roundKey, clues, vote: null, guess: null });
      await until(() => host.state.players[id].clues && host.state.players[id].clues[lap], "clue from " + p.name);
    }
    assert(stow.state.game.word === null, "still secret during voting");

    if (round === 1) {
      /* everyone fingers the stowaway; the stowaway guesses wrong */
      for (const p of phones) p.write({ vote: p === stow ? lineup.find(id => id !== stow.pid) : stow.pid });
      await until(() => host.state.game.stowawayId === stow.pid, "stowaway revealed after votes");
      assert.strictEqual(stow.state.game.word, null, "stowaway still lacks the word while guessing");
      const wrong = stow.state.game.options.find(o => o !== word);
      assert(stow.state.game.options.includes(word), "the right answer is among the options");
      stow.write({ guess: wrong });
      await until(() => stow.state.game.word === word, "word revealed to stowaway at result");
      const d = E.deriveRound(host.state.game, host.state.players);
      assert.strictEqual(d.stage, "result"); assert.strictEqual(d.caught, true); assert.strictEqual(d.guessedRight, false);
      phones.filter(p => p !== stow).forEach(p => assert.strictEqual(d.points[p.pid], 1));
      host.send({ t: "deal" });
      await until(() => host.state.game.round === 2, "round 2 dealt");
      const sc = host.state.game.scores;
      phones.filter(p => p !== stow).forEach(p => assert.strictEqual(sc[p.pid], 1, "points banked for " + p.name));
      assert.notStrictEqual(host.state.game.stowawayId === E.HIDDEN ? null : host.state.game.stowawayId, stow.pid);
      assert(phones.find(p => p.state.game.stowawayId === p.pid) !== stow, "new stowaway each round");
    } else {
      /* a tie lets the stowaway escape */
      const prior = host.state.game.scores[stow.pid] || 0;
      const [a, b] = lineup.filter(id => id !== stow.pid);
      for (const p of phones) p.write({ vote: p.pid === a ? b : a });
      await until(() => host.state.game.stowawayId === stow.pid, "revealed after tie");
      const d = E.deriveRound(host.state.game, host.state.players);
      assert.strictEqual(d.stage, "result"); assert.strictEqual(d.caught, false); assert.strictEqual(d.points[stow.pid], 3);
      host.send({ t: "lobby" });
      await until(() => host.state.game.phase === "lobby", "back to lobby");
      assert.strictEqual(host.state.game.scores[stow.pid], prior + 3, "escape points banked");
      assert(!("word" in host.state.game), "word not sent in the lobby");
    }
  }

  /* a non-host can't deal while the host is present, but can take over */
  const other = phones[1];
  const before = host.state.game.round;
  other.send({ t: "deal" });
  await sleep(100);
  assert.strictEqual(host.state.game.round, before, "non-host deal ignored");
  other.send({ t: "takeHost" });
  await until(() => host.state.game.hostId === other.pid, "host handed over");

  /* disconnects show up as offline */
  phones[4].ws.close();
  await until(() => host.state.online.length === 4, "offline player noticed");

  console.log("PASS: room create/join, 2 rounds with 5 phones, secrecy, scoring, ties, host takeover, disconnects");
  phones.forEach(p => p.ws.close());
  server.close();
  process.exit(0);
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
