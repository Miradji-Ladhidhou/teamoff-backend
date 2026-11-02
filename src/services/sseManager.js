const logger = require('../utils/logger');
const { sanitizeMessage } = require('../utils/sanitizeLogData');

// Map of userId (string) -> Set of SSE response objects
const clients = new Map();
const cleanupHandlers = new Map();
let interval = null;

function addClient(userId, res, cleanup) {
  const id = String(userId);
  if (!clients.has(id)) clients.set(id, new Set());
  clients.get(id).add(res);
  if (cleanup) cleanupHandlers.set(res, cleanup);
  logger.info(`SSE: client connected userId=${id} (total=${clients.get(id).size})`);
}

function removeClient(userId, res) {
  const id = String(userId);
  const set = clients.get(id);
  if (!set) return;
  set.delete(res);
  cleanupHandlers.delete(res);
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
      logger.warn(`SSE write error userId=${id}: ${sanitizeMessage(err.message)}`);
      try { cleanupHandlers.get(res)?.(); } catch (error) {
        logger.error('sse_client_cleanup_failed', { error: sanitizeMessage(error.message) });
      }
      removeClient(userId, res);
    }
  }
}

// Purge connections that have already closed (res.writableEnded = true)
function purgeClosedClients() {
  for (const [userId, set] of clients) {
    for (const res of set) {
      if (res.writableEnded) {
        try { cleanupHandlers.get(res)?.(); } catch (error) {
          logger.error('sse_client_cleanup_failed', { error: sanitizeMessage(error.message) });
        }
        removeClient(userId, res);
        logger.info(`SSE: purged dead connection userId=${userId}`);
      }
    }
    if (set.size === 0) clients.delete(userId);
  }
}

function initialize() {
  if (interval !== null) return;
  interval = setInterval(purgeClosedClients, 30_000);
}

function stop() {
  if (interval !== null) {
    clearInterval(interval);
    interval = null;
  }
  const errors = [];
  for (const set of clients.values()) {
    for (const res of [...set]) {
      try { cleanupHandlers.get(res)?.(); } catch (error) { errors.push(error); }
      try { if (!res.writableEnded) res.end(); } catch (error) { errors.push(error); }
    }
  }
  clients.clear();
  cleanupHandlers.clear();
  if (errors.length) throw new AggregateError(errors, 'Arrêt SSE incomplet.');
}

module.exports = { addClient, removeClient, sendToUser, initialize, stop };
