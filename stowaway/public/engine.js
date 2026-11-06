/* Stowaway game rules, shared by the server (require) and the browser (<script>). */
(function (root) {
  const BANK = [
    {c:"Snacks for the trip", w:["Pretzels","Banana","Sandwich","Popcorn","Chocolate","Sushi","Croissant","Apple","Beef jerky","Muffin","Gummy bears","Trail mix"]},
    {c:"Animals", w:["Penguin","Giraffe","Octopus","Kangaroo","Owl","Hedgehog","Shark","Camel","Flamingo","Sloth","Bee","Wolf"]},
    {c:"Jobs", w:["Dentist","Pilot","Chef","Firefighter","Librarian","Plumber","Astronaut","Barista","Judge","Farmer","Magician","Lifeguard"]},
    {c:"At the station", w:["Ticket","Platform","Conductor","Timetable","Suitcase","Pigeon","Bench","Escalator","Whistle","Tunnel","Vending machine","Announcement"]},
    {c:"Vacation spots", w:["Beach","Ski resort","Campsite","Cruise ship","Theme park","Desert","Island","Castle","Jungle","Museum","Volcano","Vineyard"]},
    {c:"Sports", w:["Tennis","Surfing","Bowling","Fencing","Golf","Rugby","Archery","Skiing","Boxing","Volleyball","Cycling","Ice hockey"]},
    {c:"Around the house", w:["Toaster","Pillow","Mirror","Fridge","Candle","Ladder","Sofa","Umbrella","Bathtub","Doormat","Alarm clock","Kettle"]},
    {c:"Things with wheels", w:["Skateboard","Tractor","Wheelbarrow","Ambulance","Roller skates","Shopping cart","Scooter","Bus","Wheelchair","Unicycle","Stroller","Ice cream truck"]},
    {c:"Weather and sky", w:["Rainbow","Thunder","Fog","Hail","Tornado","Sunset","Moon","Comet","Drizzle","Snowflake","Cloud","Northern lights"]},
    {c:"Music", w:["Guitar","Drums","Violin","Karaoke","Choir","Piano","DJ","Trumpet","Lullaby","Harmonica","Opera","Banjo"]},
    {c:"Fantasy", w:["Dragon","Wizard","Unicorn","Mermaid","Giant","Potion","Magic wand","Goblin","Fairy","Crown","Treasure","Ghost"]},
    {c:"Clothing", w:["Scarf","Sneakers","Tuxedo","Pajamas","Raincoat","Sunglasses","Mittens","Necktie","Swimsuit","Hoodie","Sandals","Apron"]},
    {c:"Food from around the world", w:["Pizza","Tacos","Ramen","Croissant","Curry","Paella","Dumplings","Falafel","Pancakes","Burrito","Pad thai","Fondue"]},
    {c:"Things in an office", w:["Stapler","Printer","Whiteboard","Coffee mug","Spreadsheet","Sticky note","Swivel chair","Calendar","Headset","Paperclip","Water cooler","Badge"]}
  ];
  /* Placeholder the server sends instead of the stowaway's id while clues and votes are open. */
  const HIDDEN = "?";

  function norm(s) { return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, ""); }
  function shuffle(a, rnd) { rnd = rnd || Math.random; a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  /* Deal a fresh round. prev carries used words, the last stowaway and the round count. */
  function dealRound(prev, ids, rnd) {
    rnd = rnd || Math.random; prev = prev || {};
    let used = new Set(prev.used || []);
    let pool = [];
    const fill = () => BANK.forEach((cat, ci) => cat.w.forEach(w => { if (!used.has(cat.c + "|" + w)) pool.push([ci, w]); }));
    fill(); if (!pool.length) { used = new Set(); fill(); }
    const [ci, word] = pool[Math.floor(rnd() * pool.length)];
    const cat = BANK[ci];
    const options = shuffle([word].concat(shuffle(cat.w.filter(x => x !== word), rnd).slice(0, 7)), rnd);
    let cands = ids.filter(id => id !== prev.lastStowaway); if (!cands.length) cands = ids.slice();
    const stowawayId = cands[Math.floor(rnd() * cands.length)];
    const lineup = shuffle(ids, rnd);
    if (lineup[0] === stowawayId) lineup.push(lineup.shift());
    return { category: cat.c, word, options, stowawayId, lastStowaway: stowawayId, lineup,
      used: Array.from(used).concat(cat.c + "|" + word).slice(-150), round: (prev.round || 0) + 1 };
  }

  /* Same scoring in both modes. */
  function scoreRound(live, stowawayId, caught, guessedRight) {
    const pts = {};
    if (!caught) pts[stowawayId] = 3;
    else if (guessedRight) pts[stowawayId] = 2;
    else live.forEach(id => { if (id !== stowawayId) pts[id] = 1; });
    return pts;
  }

  /* Everything about the current round is derived from the game record plus each player's own record.
     The server runs this with full information; phones run it with the secret parts redacted. */
  function deriveRound(g, players) {
    const skipped = g.skipped || [];
    const live = (g.lineup || []).filter(id => !skipped.includes(id));
    const hidden = g.stowawayId === HIDDEN;
    const base = { live, clues: [], turn: null };
    if ((!hidden && !live.includes(g.stowawayId)) || live.length < 2) return Object.assign(base, { stage: "void" });
    const pr = id => { const p = players[id]; return p && p.roundKey === g.roundKey ? p : null; };
    const laps = g.laps || 1;
    for (let lap = 0; lap < laps; lap++) for (const id of live) {
      const p = pr(id); const c = p && p.clues && p.clues[lap];
      if (c) base.clues.push({ id, lap, text: c }); else if (!base.turn) base.turn = { id, lap };
    }
    if (base.turn) return Object.assign(base, { stage: "clues" });
    const votes = {}, tally = {}, waiting = [];
    live.forEach(id => tally[id] = 0);
    for (const id of live) { const p = pr(id); const v = p && p.vote; if (v && v !== id && live.includes(v)) { votes[id] = v; tally[v]++; } else waiting.push(id); }
    Object.assign(base, { votes, tally, waiting });
    /* With the stowaway redacted, a phone can't settle the vote itself: it waits for the server's reveal. */
    if (waiting.length || hidden) return Object.assign(base, { stage: "vote", tallying: !waiting.length });
    const max = Math.max.apply(null, live.map(id => tally[id]));
    const top = live.filter(id => tally[id] === max);
    const accused = top.length === 1 ? top[0] : null;
    const caught = accused === g.stowawayId;
    let guess = null, guessedRight = false;
    if (caught) {
      const p = pr(g.stowawayId); guess = (p && p.guess) || null;
      /* No guess yet, or the stowaway's phone hasn't been told the word yet: still guessing. */
      if (!guess || g.word == null) return Object.assign(base, { stage: "guess", accused, caught, guess });
      guessedRight = norm(guess) === norm(g.word);
    }
    return Object.assign(base, { stage: "result", accused, caught, guess, guessedRight, points: scoreRound(live, g.stowawayId, caught, guessedRight) });
  }

  const api = { BANK, HIDDEN, norm, shuffle, dealRound, scoreRound, deriveRound };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Stowaway = api;
})(typeof self !== "undefined" ? self : this);
