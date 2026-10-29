"use strict";

const engine = require("../shared/engine");
const store = require("../shared/store");
const { json, fail, body, loadRoom, handler } = require("../shared/http");

module.exports = handler(async function (context, req) {
  const room = await loadRoom(context, req);
  if (!room) return;

  const result = engine.addPlayer(room, body(req).name);
  if (result.error) return fail(context, result.status, result.error);

  await store.put(room);

  json(context, 201, {
    playerId: result.player.id,
    playerToken: result.player.token,
    name: result.player.name,
    room: engine.publicView(room, result.player.id)
  });
});
