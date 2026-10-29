"use strict";

/**
 * Pure game logic. No I/O, no Azure types — so this file is also the
 * reference for what a native iOS client can expect from the API.
 */

const BANK = require("./bank.json");

const ERAS = ["80s", "90s", "00s", "10s", "20s"];
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
const MAX_PLAYERS = 6;
const MAX_NAME = 14;
const ROOM_TTL_SECONDS = 6 * 60 * 60;
const GRACE_MS = 1200; // tolerance for network lag on a late answer

const DEFAULTS = { questionCount: 10, clockSeconds: 20, eras: ERAS.slice() };

function randomInt(n) {
  return Math.floor(Math.random() * n);
}

function roomCode() {
  let out = "";
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

function token() {
  let out = "";
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < 32; i++) out += chars[randomInt(chars.length)];
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Normalise whatever the client sent into a safe room configuration. */
function normaliseSettings(input) {
  const raw = input || {};
  const eras = Array.isArray(raw.eras) ? raw.eras.filter((e) => ERAS.includes(e)) : [];
  const count = parseInt(raw.questionCount, 10);
  const clock = parseInt(raw.clockSeconds, 10);
  return {
    eras: eras.length ? eras : DEFAULTS.eras,
    questionCount: [5, 10, 15, 20].includes(count) ? count : DEFAULTS.questionCount,
    clockSeconds: [15, 20, 30].includes(clock) ? clock : DEFAULTS.clockSeconds
  };
}

/**
 * Deal a round, round-robin across the chosen eras so a single decade
 * can never dominate. Returns fewer questions than asked if the pool is short.
 */
function dealQuestions(settings) {
  const inPlay = BANK.questions.filter((q) => settings.eras.includes(q.era));
  const byEra = {};
  for (const q of shuffle(inPlay)) {
    if (!byEra[q.era]) byEra[q.era] = [];
    byEra[q.era].push(q);
  }

  const order = shuffle(settings.eras);
  const want = Math.min(settings.questionCount, inPlay.length);
  const picks = [];

  // Some songs carry more than one question. Hearing the same track twice in
  // one round feels like a bug to players, so skip past a repeat unless the
  // pool is too thin to avoid it.
  const used = new Set();
  const songKey = (q) => JSON.stringify([q.song, q.artist]).toLowerCase();
  const takeFrom = (list) => {
    for (let i = 0; i < list.length; i++) {
      if (!used.has(songKey(list[i]))) return list.splice(i, 1)[0];
    }
    return list.shift(); // a repeated song beats a short round
  };

  while (picks.length < want) {
    let took = 0;
    for (const era of order) {
      if (picks.length >= want) break;
      const list = byEra[era];
      if (list && list.length) {
        const q = takeFrom(list);
        used.add(songKey(q));
        picks.push(q);
        took++;
      }
    }
    if (!took) break; // pool exhausted
  }

  return shuffle(picks).map((q) => {
    const choices = shuffle([q.answer].concat(q.wrong));
    return {
      id: q.id,
      prompt: q.prompt,
      choices,
      correctIndex: choices.indexOf(q.answer),
      song: q.song,
      artist: q.artist,
      year: q.year,
      era: q.era,
      difficulty: q.difficulty
    };
  });
}

function poolSize(eras) {
  const list = Array.isArray(eras) && eras.length ? eras : ERAS;
  return BANK.questions.filter((q) => list.includes(q.era)).length;
}

function newRoom(settingsInput) {
  const settings = normaliseSettings(settingsInput);
  const code = roomCode();
  return {
    id: code,
    code,
    hostToken: token(),
    phase: "lobby", // lobby | question | reveal | final
    eras: settings.eras,
    questionCount: settings.questionCount,
    clockSeconds: settings.clockSeconds,
    index: -1,
    questionStartedAt: null,
    questions: [],
    players: [],
    createdAt: new Date().toISOString(),
    ttl: ROOM_TTL_SECONDS
  };
}

function addPlayer(room, nameInput) {
  const name = String(nameInput || "").trim().slice(0, MAX_NAME);
  if (!name) return { error: "A name is required.", status: 400 };
  if (room.phase !== "lobby") return { error: "That game has already started.", status: 409 };
  if (room.players.length >= MAX_PLAYERS) return { error: "That room is full (6 players).", status: 409 };

  const taken = room.players.some((p) => p.name.toLowerCase() === name.toLowerCase());
  if (taken) return { error: "Someone in the room already took that name.", status: 409 };

  const player = {
    id: token().slice(0, 12),
    token: token(),
    name,
    score: 0,
    right: 0,
    streak: 0,
    best: 0,
    answers: {}
  };
  room.players.push(player);
  return { player };
}

function startRound(room) {
  if (room.phase !== "lobby") return { error: "That game has already started.", status: 409 };
  if (!room.players.length) return { error: "Nobody has joined yet.", status: 409 };

  room.questions = dealQuestions({
    eras: room.eras,
    questionCount: room.questionCount,
    clockSeconds: room.clockSeconds
  });
  if (!room.questions.length) return { error: "No questions match those eras.", status: 409 };

  room.index = 0;
  room.phase = "question";
  room.questionStartedAt = new Date().toISOString();
  return { ok: true };
}

function msElapsed(room, now) {
  if (!room.questionStartedAt) return 0;
  return (now || Date.now()) - new Date(room.questionStartedAt).getTime();
}

function clockExpired(room, now) {
  return msElapsed(room, now) > room.clockSeconds * 1000 + GRACE_MS;
}

function everyoneAnswered(room) {
  return room.players.length > 0 && room.players.every((p) => p.answers[room.index] !== undefined);
}

/**
 * Points: half guaranteed for a correct answer, half riding on the clock,
 * plus a streak bonus. Scored from the server's own timestamps, never the
 * client's, so a doctored request cannot buy points.
 */
function scoreAnswer(room, player, choiceIndex, now) {
  const q = room.questions[room.index];
  const elapsed = msElapsed(room, now);
  const limit = room.clockSeconds * 1000;
  const late = elapsed > limit + GRACE_MS;
  const correct = !late && choiceIndex === q.correctIndex;

  let points = 0;
  if (correct) {
    const frac = Math.max(0, Math.min(1, 1 - elapsed / limit));
    points = Math.round((500 + 500 * frac) / 10) * 10;
    player.streak += 1;
    if (player.streak > 1) points += Math.min(250, 50 * (player.streak - 1));
    player.best = Math.max(player.best, player.streak);
    player.score += points;
    player.right += 1;
  } else {
    player.streak = 0;
  }

  player.answers[room.index] = { choiceIndex, correct, points, elapsedMs: elapsed, late };
  return { correct, points, late };
}

function submitAnswer(room, player, choiceIndexInput) {
  if (room.phase !== "question") return { error: "Not taking answers right now.", status: 409 };
  if (player.answers[room.index] !== undefined) return { error: "You already locked one in.", status: 409 };

  const choiceIndex = parseInt(choiceIndexInput, 10);
  if (!(choiceIndex >= 0 && choiceIndex <= 3)) return { error: "Pick one of the four answers.", status: 400 };

  return { result: scoreAnswer(room, player, choiceIndex, Date.now()) };
}

/** Move the room forward one beat. Host-driven, plus lazy time-outs. */
function advance(room) {
  if (room.phase === "question") {
    room.phase = "reveal";
    // anyone who never answered takes a zero and loses their streak
    for (const p of room.players) {
      if (p.answers[room.index] === undefined) {
        p.streak = 0;
        p.answers[room.index] = { choiceIndex: null, correct: false, points: 0, elapsedMs: null, late: true };
      }
    }
    return { ok: true };
  }

  if (room.phase === "reveal") {
    if (room.index + 1 >= room.questions.length) {
      room.phase = "final";
      room.questionStartedAt = null;
    } else {
      room.index += 1;
      room.phase = "question";
      room.questionStartedAt = new Date().toISOString();
    }
    return { ok: true };
  }

  return { error: "Nothing to advance.", status: 409 };
}

/**
 * Called on every host poll: closes a question whose clock has run out or
 * whose players have all answered. Returns true if the room changed and
 * needs saving. This is why the game needs no timer service.
 */
function settle(room) {
  if (room.phase !== "question") return false;
  if (everyoneAnswered(room) || clockExpired(room)) {
    advance(room);
    return true;
    }
  return false;
}

function leaderboard(room) {
  return room.players
    .slice()
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, score: p.score, right: p.right, best: p.best }));
}

/**
 * The only shape any client ever sees. Correct answers are withheld until
 * the room is in `reveal`, and future questions are never sent at all.
 */
function publicView(room, viewerId) {
  const q = room.index >= 0 ? room.questions[room.index] : null;
  const revealing = room.phase === "reveal";

  const view = {
    code: room.code,
    phase: room.phase,
    index: room.index,
    total: room.questions.length || room.questionCount,
    clockSeconds: room.clockSeconds,
    eras: room.eras,
    serverNow: new Date().toISOString(),
    questionStartedAt: room.questionStartedAt,
    msRemaining: room.phase === "question" ? Math.max(0, room.clockSeconds * 1000 - msElapsed(room)) : 0,
    answeredCount: room.players.filter((p) => p.answers[room.index] !== undefined).length,
    players: room.players.map((p) => {
      const a = p.answers[room.index];
      return {
        id: p.id,
        name: p.name,
        score: p.score,
        streak: p.streak,
        answered: a !== undefined,
        // what they picked stays private until the reveal
        lastCorrect: revealing && a ? a.correct : null,
        lastPoints: revealing && a ? a.points : null
      };
    }),
    question: null,
    reveal: null,
    you: null
  };

  if (q && (room.phase === "question" || revealing)) {
    view.question = {
      index: room.index,
      prompt: q.prompt,
      choices: q.choices,
      era: q.era,
      difficulty: q.difficulty
    };
  }

  if (q && revealing) {
    view.reveal = {
      correctIndex: q.correctIndex,
      correctText: q.choices[q.correctIndex],
      song: q.song,
      artist: q.artist,
      year: q.year
    };
  }

  if (room.phase === "final") view.leaderboard = leaderboard(room);

  if (viewerId) {
    const me = room.players.find((p) => p.id === viewerId);
    if (me) {
      const a = me.answers[room.index];
      view.you = {
        id: me.id,
        name: me.name,
        score: me.score,
        streak: me.streak,
        right: me.right,
        best: me.best,
        picked: a ? a.choiceIndex : null,
        lastCorrect: revealing && a ? a.correct : null,
        lastPoints: revealing && a ? a.points : null
      };
    }
  }

  return view;
}

module.exports = {
  ERAS,
  MAX_PLAYERS,
  DEFAULTS,
  bankVersion: BANK.version,
  roomCode,
  token,
  poolSize,
  normaliseSettings,
  newRoom,
  addPlayer,
  startRound,
  submitAnswer,
  advance,
  settle,
  publicView,
  leaderboard,
  clockExpired,
  everyoneAnswered
};
