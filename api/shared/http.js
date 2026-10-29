"use strict";

/**
 * Shared HTTP plumbing. Every endpoint returns JSON and authenticates with a
 * bearer token, never a cookie — that is what lets a native iOS client use
 * exactly the same API as the browser.
 */

const store = require("./store");

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(context, status, body) {
  context.res = { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function fail(context, status, message) {
  json(context, status, { error: message });
}

/**
 * Azure Static Web Apps consumes the Authorization header in its own auth
 * pipeline and never forwards it to a managed function, so the game token
 * travels in a header of its own. The Authorization fallback keeps this
 * working against a standalone Function App or a local `func start`.
 */
function bearer(req) {
  const headers = req.headers || {};
  const custom = headers["x-game-token"] || headers["X-Game-Token"];
  if (custom) return String(custom).trim();

  const header = headers.authorization || headers.Authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : null;
}

function normaliseCode(raw) {
  return String(raw || "").trim().toUpperCase();
}

/** Load a room by the route's {code}, or respond 404 and return null. */
async function loadRoom(context, req) {
  const code = normaliseCode(req.params && req.params.code);
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    fail(context, 400, "That room code does not look right.");
    return null;
  }
  const room = await store.get(code);
  if (!room) {
    fail(context, 404, "No game with that code. It may have expired.");
    return null;
  }
  return room;
}

/** Require the host's token. */
function asHost(context, req, room) {
  if (bearer(req) !== room.hostToken) {
    fail(context, 403, "Only the host screen can do that.");
    return false;
  }
  return true;
}

/** Require a player's token; returns the player or null (having responded). */
function asPlayer(context, req, room) {
  const tok = bearer(req);
  const player = tok ? room.players.find((p) => p.token === tok) : null;
  if (!player) {
    fail(context, 403, "You are not in this game.");
    return null;
  }
  return player;
}

function body(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (err) {
      return {};
    }
  }
  return req.body;
}

/** Wrap a handler so an unexpected throw becomes a 500 instead of a hang. */
function handler(fn) {
  return async function (context, req) {
    try {
      await fn(context, req);
    } catch (err) {
      context.log.error("unhandled", err && err.stack ? err.stack : err);
      fail(context, 500, "Something broke on our end. Try again.");
    }
  };
}

module.exports = { json, fail, bearer, body, loadRoom, asHost, asPlayer, handler, normaliseCode };
