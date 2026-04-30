const logger = require('../utils/logger');

// Map of userId (string) -> Set of SSE response objects
const clients = new Map();

function addClient(userId, res) {
  const id = String(userId);
  if (!clients.has(id)) clients.set(id, new Set());
  clients.get(id).add(res);
  logger.info(`SSE: client connected userId=${id} (total=${clients.get(id).size})`);
}

function removeClient(userId, res) {
  const id = String(userId);
  const set = clients.get(id);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(id);
}

function sendToUser(userId, eventName, data) {
  const id = String(userId);
  const set = clients.get(id);
  if (!set || set.size === 0) return;

  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch (err) {
      logger.warn(`SSE write error userId=${id}: ${err.message}`);
      set.delete(res);
    }
  }
}

// Purge connections that have already closed (res.writableEnded = true)
setInterval(() => {
  for (const [userId, set] of clients) {
    for (const res of set) {
      if (res.writableEnded) {
        set.delete(res);
        logger.info(`SSE: purged dead connection userId=${userId}`);
      }
    }
    if (set.size === 0) clients.delete(userId);
  }
}, 30_000);

module.exports = { addClient, removeClient, sendToUser };
