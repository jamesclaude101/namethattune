"use strict";

/**
 * Name That Tune — browser client for both roles.
 *
 * The server owns the game: it deals the questions, keeps the clock and does
 * the scoring. This file only renders what /api/v1/rooms/{code} reports and
 * posts the player's taps back. A native iOS client is the same contract.
 */

var API = "/api/v1";
var SHAPES = ["tri", "dia", "cir", "sq"];
var ERAS = ["80s", "90s", "00s", "10s", "20s"];
var STORE_KEY = "ntt.session";

var view = document.getElementById("view");

var S = {
  mode: null,          // "host" | "player"
  screen: "landing",
  code: null,
  hostToken: null,
  playerToken: null,
  playerId: null,
  room: null,          // most recent public view
  anchor: 0,           // Date.now() when `room` arrived
  settings: { eras: ERAS.slice(), questionCount: 10, clockSeconds: 20 },
  seenPlayers: [],
  pendingChoice: null, // locked in locally before the server confirms
  painted: null,       // signature of what the DOM currently shows
  error: null
};

var pollTimer = null;
var clockTimer = null;

/* ------------------------------------------------------------------ utils */

function tpl(name) {
  var node = document.getElementById("t-" + name);
  return node.content.cloneNode(true);
}

function slot(root, name) {
  return root.querySelector('[data-slot="' + name + '"]');
}

function text(root, name, value) {
  var el = slot(root, name);
  if (el) el.textContent = value;
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      mode: S.mode, code: S.code, hostToken: S.hostToken,
      playerToken: S.playerToken, playerId: S.playerId
    }));
  } catch (err) { /* private mode — the game still works, a refresh just loses it */ }
}

function restore() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function clearSession() {
  try { localStorage.removeItem(STORE_KEY); } catch (err) {}
  S.mode = S.code = S.hostToken = S.playerToken = S.playerId = null;
  S.room = null;
  S.pendingChoice = null;
  S.seenPlayers = [];
}

function myToken() {
  return S.mode === "host" ? S.hostToken : S.playerToken;
}

async function call(method, path, payload) {
  var opts = { method: method, headers: {} };
  var tok = myToken();
  if (tok) {
    // Static Web Apps swallows Authorization before the API sees it, so the
    // token rides in its own header. Both are sent: the fallback matters if
    // the API is ever hosted somewhere that passes Authorization through.
    opts.headers["X-Game-Token"] = tok;
    opts.headers["Authorization"] = "Bearer " + tok;
  }
  if (payload !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(payload);
  }
  var res = await fetch(API + path, opts);
  var data = null;
  try { data = await res.json(); } catch (err) { data = {}; }
  if (!res.ok) {
    var err = new Error((data && data.error) || "Request failed.");
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ----------------------------------------------------------------- clocks */

function msLeft() {
  if (!S.room || S.room.phase !== "question") return 0;
  var drift = Date.now() - S.anchor;
  return Math.max(0, S.room.msRemaining - drift);
}

function paintClock() {
  var ring = document.querySelector("[data-slot=ring]");
  if (!ring || !S.room) return;
  var total = S.room.clockSeconds * 1000;
  var left = msLeft();
  ring.style.setProperty("--pct", (total ? (left / total) * 100 : 0) + "%");
  ring.classList.toggle("urgent", left <= 5000);
  var out = slot(ring, "clock");
  if (out) out.textContent = Math.ceil(left / 1000);
}

function startClock() {
  stopClock();
  clockTimer = setInterval(paintClock, 100);
}

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

/* ------------------------------------------------------------------ polls */

function pollDelay() {
  if (!S.room) return 1200;
  if (S.room.phase === "question") return S.mode === "host" ? 600 : 900;
  if (S.room.phase === "final") return 4000;
  return 1200;
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll() {
  stopPolling();
  pollTimer = setTimeout(poll, pollDelay());
}

async function poll() {
  if (!S.code) return;
  try {
    var room = await call("GET", "/rooms/" + S.code);
    applyRoom(room);
  } catch (err) {
    if (err.status === 404) {
      fatal("That game is over or expired.");
      return;
    }
    // transient: a dropped request is normal on a phone, just try again
  }
  schedulePoll();
}

function applyRoom(room) {
  var prev = S.room;
  S.room = room;
  S.anchor = Date.now();

  // a new question clears any local lock-in
  if (!prev || prev.index !== room.index || prev.phase !== room.phase) {
    if (room.phase === "question") S.pendingChoice = null;
  }

  // Rebuilding the view on every poll yanks the node out from under a finger
  // that is mid-press on an answer tile: the pointer goes down on a button
  // that no longer exists when it comes up, no click fires, and the player is
  // scored zero for a question they answered. So repaint only when something
  // other than the clock changed. The countdown is unaffected — paintClock
  // runs on its own interval and reads S.room and S.anchor directly.
  if (viewSignature() !== S.painted) render();
}

/**
 * Everything the current screen draws, except the clock. Deliberately not a
 * hash of the whole room: serverNow, msRemaining and questionStartedAt move
 * every poll and would make this always differ.
 */
function viewSignature() {
  var r = S.room;
  var head = [screenName(), S.pendingChoice, S.error, S.joinError || null];
  if (!r) return JSON.stringify(head);
  return JSON.stringify(head.concat([
    r.phase, r.index, r.total, r.answeredCount,
    r.question && r.question.prompt, r.question && r.question.choices,
    r.reveal, r.leaderboard || null, r.players, r.you || null
  ]));
}

/* ----------------------------------------------------------------- screens */

function screenName() {
  if (S.error) return "error";
  if (!S.room) return S.screen;
  if (S.mode === "host") {
    if (S.room.phase === "lobby") return "host-lobby";
    if (S.room.phase === "question") return "host-question";
    if (S.room.phase === "reveal") return "host-reveal";
    if (S.room.phase === "final") return "host-final";
  }
  if (S.mode === "player") {
    if (S.room.phase === "lobby") return "player-wait";
    if (S.room.phase === "question") {
      var picked = S.pendingChoice !== null ||
        (S.room.you && S.room.you.picked !== null && S.room.you.picked !== undefined);
      return picked ? "player-locked" : "player-question";
    }
    if (S.room.phase === "reveal") return "player-reveal";
    if (S.room.phase === "final") return "player-final";
  }
  return S.screen;
}

function render() {
  var name = screenName();
  var node;

  switch (name) {
    case "landing":        node = renderLanding(); break;
    case "host-setup":     node = renderHostSetup(); break;
    case "host-lobby":     node = renderHostLobby(); break;
    case "host-question":  node = renderHostQuestion(); break;
    case "host-reveal":    node = renderHostReveal(); break;
    case "host-final":     node = renderHostFinal(); break;
    case "join":           node = renderJoin(); break;
    case "player-wait":    node = renderPlayerWait(); break;
    case "player-question":node = renderPlayerQuestion(); break;
    case "player-locked":  node = renderPlayerLocked(); break;
    case "player-reveal":  node = renderPlayerReveal(); break;
    case "player-final":   node = renderPlayerFinal(); break;
    default:               node = renderError(); break;
  }

  view.classList.toggle("host", S.mode === "host");
  view.innerHTML = "";
  view.appendChild(node);
  S.painted = viewSignature();

  if (S.room && S.room.phase === "question") {
    paintClock();
    startClock();
  } else {
    stopClock();
  }
}

function renderLanding() {
  return tpl("landing");
}

function renderError() {
  var node = tpl("error");
  text(node, "msg", S.error || "Something went sideways.");
  return node;
}

/* --------------------------------------------------------------- host side */

function renderHostSetup() {
  var node = tpl("host-setup");

  node.querySelectorAll("[data-chips]").forEach(function (wrap) {
    var key = wrap.dataset.chips;
    wrap.querySelectorAll(".chip").forEach(function (chip) {
      if (key === "eras") chip.classList.toggle("on", S.settings.eras.indexOf(chip.dataset.era) > -1);
      else chip.classList.toggle("on", String(S.settings[key]) === chip.dataset.value);
    });
  });

  var pool = slot(node, "pool");
  if (!S.settings.eras.length) pool.textContent = "Pick at least one era.";
  else pool.textContent = S.settings.eras.length + " era" +
    (S.settings.eras.length > 1 ? "s" : "") + " selected · up to 6 players";

  return node;
}

function renderHostLobby() {
  var node = tpl("host-lobby");
  var origin = location.origin + location.pathname.replace(/index\.html$/, "");
  text(node, "joinurl", origin.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  text(node, "code", S.room.code);

  var roster = slot(node, "roster");
  if (!S.room.players.length) {
    roster.innerHTML = '<span class="empty">Waiting for the first phone…</span>';
  } else {
    S.room.players.forEach(function (p) {
      var el = document.createElement("span");
      el.className = "who" + (S.seenPlayers.indexOf(p.id) === -1 ? " fresh" : "");
      el.textContent = p.name;
      roster.appendChild(el);
    });
  }
  S.seenPlayers = S.room.players.map(function (p) { return p.id; });

  var btn = node.querySelector('[data-action="start"]');
  btn.disabled = S.room.players.length === 0;
  text(node, "lobbynote", S.room.players.length
    ? S.room.players.length + " of 6 in. Start whenever."
    : "Nobody can score until somebody joins.");

  return node;
}

function questionTiles(room, opts) {
  var frag = document.createDocumentFragment();
  var reveal = room.reveal;
  (room.question ? room.question.choices : []).forEach(function (choiceText, i) {
    var b = document.createElement("button");
    b.className = "ans";
    b.dataset.choice = String(i);
    if (opts.locked) b.disabled = true;
    if (reveal) {
      if (i === reveal.correctIndex) b.classList.add("right");
      else b.classList.add("dim");
    }
    if (opts.chosen === i) b.classList.add("chosen");
    var sh = document.createElement("span");
    sh.className = "sh " + SHAPES[i];
    var tx = document.createElement("span");
    tx.className = "txt";
    tx.textContent = choiceText;
    b.appendChild(sh);
    b.appendChild(tx);
    frag.appendChild(b);
  });
  return frag;
}

function renderHostQuestion() {
  var node = tpl("host-question");
  var r = S.room;
  text(node, "qnum", (r.index + 1) + "/" + r.total);
  text(node, "answered", r.answeredCount + "/" + r.players.length);
  text(node, "prompt", r.question ? r.question.prompt : "");

  var tags = slot(node, "tags");
  if (r.question) {
    tags.innerHTML = '<span class="tag">' + eraLabel(r.question.era) + '</span>' +
      '<span class="tag' + (r.question.difficulty === "hard" ? " hard" : "") + '">' +
      r.question.difficulty + "</span>";
  }

  slot(node, "prog").style.width = (r.index / r.total * 100) + "%";
  slot(node, "choices").appendChild(questionTiles(r, { locked: true }));
  return node;
}

function renderHostReveal() {
  var node = tpl("host-reveal");
  var r = S.room;
  text(node, "qnum", (r.index + 1) + "/" + r.total);
  text(node, "prompt", r.question ? r.question.prompt : "");
  slot(node, "choices").appendChild(questionTiles(r, { locked: true }));

  if (r.reveal) {
    text(node, "song", "“" + r.reveal.song + "”");
    text(node, "meta", r.reveal.artist + " · " + r.reveal.year);
  }

  slot(node, "board").appendChild(boardLines(r, { showDelta: true }));
  text(node, "nextbtn", r.index + 1 >= r.total ? "Show the final scores" : "Next question");
  return node;
}

function renderHostFinal() {
  var node = tpl("host-final");
  var board = S.room.leaderboard || [];
  text(node, "winner", board.length ? board[0].name + " takes it" : "Nobody scored");
  slot(node, "board").appendChild(boardLines(S.room, { final: true }));
  return node;
}

/* ------------------------------------------------------------- player side */

function renderJoin() {
  var node = tpl("join");
  var err = slot(node, "joinerr");
  err.textContent = S.joinError || "";
  setTimeout(function () {
    var codeInput = document.getElementById("f-code");
    if (codeInput && S.prefillCode) codeInput.value = S.prefillCode;
    var target = codeInput && !codeInput.value ? codeInput : document.getElementById("f-name");
    if (target) target.focus();
  }, 0);
  return node;
}

function renderPlayerWait() {
  var node = tpl("player-wait");
  text(node, "name", (S.room.you && S.room.you.name) || "");
  var roster = slot(node, "roster");
  S.room.players.forEach(function (p) {
    var el = document.createElement("span");
    el.className = "who";
    el.textContent = p.name;
    roster.appendChild(el);
  });
  text(node, "waitnote", S.room.players.length + " of 6 here. Watch the big screen.");
  return node;
}

function renderPlayerQuestion() {
  var node = tpl("player-question");
  var r = S.room;
  text(node, "score", r.you ? r.you.score : 0);
  text(node, "qnum", (r.index + 1) + "/" + r.total);
  text(node, "prompt", r.question ? r.question.prompt : "");
  slot(node, "choices").appendChild(questionTiles(r, { locked: false }));
  return node;
}

function renderPlayerLocked() {
  var node = tpl("player-locked");
  var r = S.room;
  var picked = S.pendingChoice !== null ? S.pendingChoice : (r.you ? r.you.picked : null);
  var label = (r.question && picked !== null && r.question.choices[picked]) || "Your answer";
  text(node, "picked", label);
  text(node, "waiting", r.answeredCount + " of " + r.players.length + " locked in");
  return node;
}

function renderPlayerReveal() {
  var node = tpl("player-reveal");
  var r = S.room;
  var you = r.you || {};
  var ok = you.lastCorrect === true;

  var v = slot(node, "verdict");
  v.className = "verdict " + (ok ? "ok" : "no");
  v.textContent = ok ? (you.streak >= 3 ? "Streak ×" + you.streak : "Correct") : "Nope";

  text(node, "pts", ok ? "+" + you.lastPoints : "+0");
  text(node, "correct", r.reveal
    ? "The answer was " + r.reveal.correctText + " — “" + r.reveal.song + "”, " + r.reveal.artist
    : "");
  text(node, "score", you.score || 0);
  text(node, "place", ordinal(placeOf(r, you.id)));
  return node;
}

function renderPlayerFinal() {
  var node = tpl("player-final");
  var board = S.room.leaderboard || [];
  var mine = board.find(function (row) { return row.id === S.playerId; });
  text(node, "place", mine ? ordinal(mine.rank) + " place" : "That's a wrap");
  text(node, "summary", mine
    ? mine.score.toLocaleString() + " points · " + mine.right + " right · best streak " + mine.best
    : "");
  slot(node, "board").appendChild(boardLines(S.room, { final: true }));
  return node;
}

/* ------------------------------------------------------------- shared bits */

function eraLabel(era) {
  return { "80s": "Late ’80s", "90s": "’90s", "00s": "’00s", "10s": "’10s", "20s": "’20s" }[era] || era;
}

function ordinal(n) {
  if (!n) return "—";
  var s = ["th", "st", "nd", "rd"];
  var v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function ranked(room) {
  if (room.leaderboard) return room.leaderboard;
  return room.players
    .slice()
    .sort(function (a, b) { return b.score - a.score || a.name.localeCompare(b.name); })
    .map(function (p, i) {
      return { rank: i + 1, id: p.id, name: p.name, score: p.score, lastPoints: p.lastPoints };
    });
}

function placeOf(room, id) {
  var rows = ranked(room);
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i].rank;
  return 0;
}

function boardLines(room, opts) {
  var frag = document.createDocumentFragment();
  var rows = ranked(room);
  var byId = {};
  room.players.forEach(function (p) { byId[p.id] = p; });

  rows.forEach(function (row) {
    var line = document.createElement("div");
    line.className = "line" + (row.rank === 1 ? " lead" : "") + (row.id === S.playerId ? " me" : "");

    var rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = row.rank;

    var who = document.createElement("span");
    who.className = "who";
    who.textContent = row.name;

    var score = document.createElement("b");
    score.textContent = row.score.toLocaleString();

    line.appendChild(rank);
    line.appendChild(who);

    if (opts && opts.showDelta) {
      var p = byId[row.id];
      var gained = p && typeof p.lastPoints === "number" ? p.lastPoints : 0;
      var delta = document.createElement("span");
      delta.className = "delta" + (gained ? "" : " zero");
      delta.textContent = gained ? "+" + gained : "+0";
      line.appendChild(delta);
    }

    line.appendChild(score);
    frag.appendChild(line);
  });

  if (!rows.length) {
    var empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "No players.";
    frag.appendChild(empty);
  }

  return frag;
}

function fatal(message) {
  stopPolling();
  stopClock();
  clearSession();
  S.error = message;
  render();
}

/* ------------------------------------------------------------------ actions */

function goLanding() {
  stopPolling();
  stopClock();
  clearSession();
  S.error = null;
  S.joinError = null;
  S.screen = "landing";
  S.mode = null;
  history.replaceState(null, "", location.pathname);
  render();
}

function goHostSetup() {
  stopPolling();
  stopClock();
  clearSession();
  S.error = null;
  S.mode = "host";
  S.screen = "host-setup";
  render();
}

function goJoin() {
  stopPolling();
  stopClock();
  clearSession();
  S.error = null;
  S.joinError = null;
  S.mode = "player";
  S.screen = "join";
  render();
}

async function createRoom() {
  if (!S.settings.eras.length) return;
  var btn = view.querySelector('[data-action="create"]');
  if (btn) { btn.disabled = true; btn.textContent = "Opening…"; }
  try {
    var out = await call("POST", "/rooms", S.settings);
    S.code = out.code;
    S.hostToken = out.hostToken;
    S.mode = "host";
    save();
    applyRoom(out.room);
    schedulePoll();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Open the room"; }
    S.error = err.message;
    render();
  }
}

async function startRound() {
  var btn = view.querySelector('[data-action="start"]');
  if (btn) { btn.disabled = true; btn.textContent = "Dealing…"; }
  try {
    var room = await call("POST", "/rooms/" + S.code + "/start", S.settings);
    applyRoom(room);
    schedulePoll();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Start the round"; }
  }
}

async function advanceRoom() {
  var btn = view.querySelector('[data-action="advance"]');
  if (btn) btn.disabled = true;
  try {
    var room = await call("POST", "/rooms/" + S.code + "/advance");
    applyRoom(room);
    schedulePoll();
  } catch (err) {
    if (btn) btn.disabled = false;
  }
}

async function joinRoom() {
  var codeEl = document.getElementById("f-code");
  var nameEl = document.getElementById("f-name");
  var code = (codeEl.value || "").trim().toUpperCase();
  var name = (nameEl.value || "").trim();

  if (!/^[A-Z0-9]{4}$/.test(code)) {
    S.joinError = "That code should be four characters.";
    return render();
  }
  if (!name) {
    S.joinError = "Pick a name so the scoreboard knows you.";
    return render();
  }

  var btn = view.querySelector('[data-action="join"]');
  if (btn) { btn.disabled = true; btn.textContent = "Joining…"; }

  try {
    S.playerToken = null; // join is unauthenticated
    var out = await call("POST", "/rooms/" + code + "/players", { name: name });
    S.code = code;
    S.playerId = out.playerId;
    S.playerToken = out.playerToken;
    S.mode = "player";
    S.joinError = null;
    save();
    applyRoom(out.room);
    schedulePoll();
  } catch (err) {
    S.joinError = err.message;
    S.prefillCode = code;
    render();
  }
}

async function sendAnswer(choiceIndex) {
  if (S.mode !== "player" || !S.room || S.room.phase !== "question") return;
  if (S.pendingChoice !== null) return;

  S.pendingChoice = choiceIndex; // lock the UI immediately; the clock is unforgiving
  render();

  try {
    await call("POST", "/rooms/" + S.code + "/answers", {
      questionIndex: S.room.index,
      choiceIndex: choiceIndex
    });
  } catch (err) {
    if (err.status === 409) {
      // question closed under us, or we already answered — the next poll sorts it out
    } else {
      S.pendingChoice = null;
      render();
    }
  }
  poll();
}

/* ------------------------------------------------------------- interaction */

view.addEventListener("click", function (e) {
  var go = e.target.closest("[data-go]");
  if (go) {
    var dest = go.dataset.go;
    if (dest === "landing") goLanding();
    else if (dest === "host") goHostSetup();
    else if (dest === "join") goJoin();
    return;
  }

  var act = e.target.closest("[data-action]");
  if (act) {
    var which = act.dataset.action;
    if (which === "create") createRoom();
    else if (which === "start") startRound();
    else if (which === "advance") advanceRoom();
    else if (which === "join") joinRoom();
    return;
  }

  var ans = e.target.closest(".ans[data-choice]");
  if (ans && !ans.disabled) {
    sendAnswer(parseInt(ans.dataset.choice, 10));
    return;
  }

  var chip = e.target.closest("[data-chips] .chip");
  if (chip) {
    var key = chip.closest("[data-chips]").dataset.chips;
    if (key === "eras") {
      var era = chip.dataset.era;
      var at = S.settings.eras.indexOf(era);
      if (at > -1) S.settings.eras.splice(at, 1);
      else S.settings.eras.push(era);
    } else {
      S.settings[key] = parseInt(chip.dataset.value, 10);
    }
    render();
  }
});

view.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && e.target.classList.contains("input")) {
    e.preventDefault();
    joinRoom();
  }
});

document.addEventListener("keydown", function (e) {
  if (!S.room) return;
  if (S.mode === "player" && S.room.phase === "question" && S.pendingChoice === null) {
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= 4) {
      e.preventDefault();
      sendAnswer(n - 1);
    }
  }
  if (S.mode === "host" && S.room.phase === "reveal" && (e.key === " " || e.key === "Enter")) {
    e.preventDefault();
    advanceRoom();
  }
});

// a backgrounded phone stops polling; catch up the moment it comes back
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && S.code) poll();
});

/* ------------------------------------------------------------------- boot */

(function boot() {
  var params = new URLSearchParams(location.search);
  var invited = (params.get("c") || "").trim().toUpperCase();

  var saved = restore();
  if (saved && saved.code && (saved.hostToken || saved.playerToken)) {
    S.mode = saved.mode;
    S.code = saved.code;
    S.hostToken = saved.hostToken;
    S.playerToken = saved.playerToken;
    S.playerId = saved.playerId;
    render();
    poll();
    return;
  }

  if (/^[A-Z0-9]{4}$/.test(invited)) {
    S.mode = "player";
    S.screen = "join";
    S.prefillCode = invited;
    render();
    return;
  }

  render();
})();
