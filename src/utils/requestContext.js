'use strict';
const { AsyncLocalStorage } = require('async_hooks');

// Stockage de contexte par requête — propagé automatiquement dans toute la chaîne async.
// Permet à n'importe quel logger.info() d'accéder au requestId sans le passer explicitement.
const storage = new AsyncLocalStorage();

function getRequestId() {
  return storage.getStore()?.requestId ?? 'unknown';
}

function runWithRequestId(requestId, fn) {
  storage.run({ requestId }, fn);
}

module.exports = { getRequestId, runWithRequestId };
