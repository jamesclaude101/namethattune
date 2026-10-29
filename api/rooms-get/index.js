"use strict";

const engine = require("../shared/engine");
const store = require("../shared/store");
const { json, bearer, loadRoom, handler } = require("../shared/http");

/**
 * The poll endpoint. Players read only. The host's poll additionally settles
 * a question whose clock has run out or whose players have all answered —
 * which is how the game advances without any timer service running.
 */
module.exports = handler(async function (context, req) {
  const room = await loadRoom(context, req);
  if (!room) return;

  const tok = bearer(req);
  const isHost = tok && tok === room.hostToken;
  const me = tok ? room.players.find((p) => p.token === tok) : null;

  if (isHost && engine.settle(room)) await store.put(room);

  json(context, 200, engine.publicView(room, me ? me.id : null));
});
