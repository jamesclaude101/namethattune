"use strict";

/**
 * Room persistence. Cosmos DB serverless in Azure; an in-memory map when no
 * connection string is configured, so `swa start` works locally with nothing
 * provisioned. Rooms carry a TTL and expire themselves after six hours.
 */

const DB_NAME = process.env.COSMOS_DATABASE || "namethattune";
const CONTAINER_NAME = process.env.COSMOS_CONTAINER || "rooms";

let containerPromise = null;
const memory = new Map(); // dev fallback only

function usingCosmos() {
  return Boolean(process.env.COSMOS_CONNECTION_STRING);
}

async function container() {
  if (!containerPromise) {
    const { CosmosClient } = require("@azure/cosmos");
    const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
    containerPromise = (async () => {
      const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
      const { container: c } = await database.containers.createIfNotExists({
        id: CONTAINER_NAME,
        partitionKey: { paths: ["/id"] },
        defaultTtl: -1 // per-item ttl governs; nothing expires unless it says so
      });
      return c;
    })();
  }
  return containerPromise;
}

async function get(code) {
  if (!usingCosmos()) return memory.get(code) || null;
  try {
    const { resource } = await (await container()).item(code, code).read();
    return resource || null;
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

async function put(room) {
  if (!usingCosmos()) {
    memory.set(room.id, room);
    return room;
  }
  const { resource } = await (await container()).items.upsert(room);
  return resource;
}

/** Create with collision retry — codes are only 4 characters. */
async function create(room, regenerate) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = await get(room.id);
    if (!existing) return put(room);
    room = regenerate();
  }
  throw new Error("Could not allocate a free room code.");
}

module.exports = { get, put, create, usingCosmos };
