"use strict";

const engine = require("../shared/engine");
const store = require("../shared/store");
const { json, fail, body, loadRoom, asPlayer, handler } = require("../shared/http");

module.exports = handler(async function (context, req) {
  const room = await loadRoom(context, req);
  if (!room) return;

  const player = asPlayer(context, req, room);
  if (!player) return;

  const payload = body(req);

  // guard against a stale phone answering the previous question
  const sent = parseInt(payload.questionIndex, 10);
  if (!Number.isNaN(sent) && sent !== room.index) {
    return fail(context, 409, "That question has already closed.");
  }

  const outcome = engine.submitAnswer(room, player, payload.choiceIndex);
  if (outcome.error) return fail(context, outcome.status, outcome.error);

  await store.put(room);

  // the verdict stays sealed until the reveal, so all we confirm is the lock-in
  json(context, 202, {
    locked: true,
    questionIndex: room.index,
    answeredCount: room.players.filter((p) => p.answers[room.index] !== undefined).length,
    totalPlayers: room.players.length
  });
});
