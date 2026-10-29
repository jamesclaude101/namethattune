"use strict";

const engine = require("../shared/engine");
const store = require("../shared/store");
const { json, fail, body, loadRoom, asHost, handler } = require("../shared/http");

module.exports = handler(async function (context, req) {
  const room = await loadRoom(context, req);
  if (!room) return;
  if (!asHost(context, req, room)) return;

  // the host may change the settings right up until the round starts
  const incoming = body(req);
  if (incoming && (incoming.eras || incoming.questionCount || incoming.clockSeconds)) {
    const settings = engine.normaliseSettings({
      eras: incoming.eras || room.eras,
      questionCount: incoming.questionCount || room.questionCount,
      clockSeconds: incoming.clockSeconds || room.clockSeconds
    });
    room.eras = settings.eras;
    room.questionCount = settings.questionCount;
    room.clockSeconds = settings.clockSeconds;
  }

  const result = engine.startRound(room);
  if (result.error) return fail(context, result.status, result.error);

  await store.put(room);
  json(context, 200, engine.publicView(room));
});
