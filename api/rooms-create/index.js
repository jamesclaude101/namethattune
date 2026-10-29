"use strict";

const engine = require("../shared/engine");
const store = require("../shared/store");
const { json, body, handler } = require("../shared/http");

module.exports = handler(async function (context, req) {
  const settings = engine.normaliseSettings(body(req));
  const room = await store.create(engine.newRoom(settings), () => engine.newRoom(settings));

  json(context, 201, {
    code: room.code,
    hostToken: room.hostToken,
    settings: {
      eras: room.eras,
      questionCount: room.questionCount,
      clockSeconds: room.clockSeconds
    },
    poolSize: engine.poolSize(room.eras),
    room: engine.publicView(room)
  });
});
