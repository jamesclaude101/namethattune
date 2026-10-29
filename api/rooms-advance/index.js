"use strict";

const engine = require("../shared/engine");
const store = require("../shared/store");
const { json, fail, loadRoom, asHost, handler } = require("../shared/http");

module.exports = handler(async function (context, req) {
  const room = await loadRoom(context, req);
  if (!room) return;
  if (!asHost(context, req, room)) return;

  const result = engine.advance(room);
  if (result.error) return fail(context, result.status, result.error);

  await store.put(room);
  json(context, 200, engine.publicView(room));
});
