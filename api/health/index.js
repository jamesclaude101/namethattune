"use strict";

const engine = require("../shared/engine");
const store = require("../shared/store");
const { json, handler } = require("../shared/http");

module.exports = handler(async function (context) {
  json(context, 200, {
    ok: true,
    api: "v1",
    bankVersion: engine.bankVersion,
    questions: engine.poolSize(engine.ERAS),
    eras: engine.ERAS,
    maxPlayers: engine.MAX_PLAYERS,
    persistence: store.usingCosmos() ? "cosmos" : "memory"
  });
});
