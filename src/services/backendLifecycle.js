'use strict';

const { sanitizeError } = require('../utils/sanitizeLogData');

function createBackendLifecycle({ validate, initialize, listen, logger }) {
  const resources = [];
  let startPromise;
  let stopPromise;
  let cleanupPromise;
  let stopping = false;

  function register(name, close) {
    resources.push({ name, close });
  }

  function cleanup(primaryError) {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const errors = [];
      for (const resource of [...resources].reverse()) {
        try {
          await resource.close();
        } catch (error) {
          sanitizeError(error);
          errors.push(error);
          logger.error('backend_cleanup_failed', { resource: resource.name, error: error.message });
        }
      }
      if (errors.length) {
        if (primaryError) primaryError.cleanupErrors = errors;
        else throw new AggregateError(errors, 'Arrêt du backend incomplet.');
      }
    })();
    return cleanupPromise;
  }

  function assertStarting() {
    if (stopping) throw new Error('Démarrage interrompu par une demande d’arrêt.');
  }

  function start() {
    if (startPromise) return startPromise;
    if (stopping) return Promise.reject(new Error('Backend arrêté ; redémarrer le processus.'));
    startPromise = (async () => {
      try {
        await validate(register);
        assertStarting();
        await initialize(register, assertStarting);
        assertStarting();
        await listen();
        assertStarting();
      } catch (error) {
        stopping = true;
        sanitizeError(error);
        await cleanup(error);
        throw error;
      }
    })();
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      if (startPromise) {
        try { await startPromise; } catch { /* Startup already reports its primary error. */ }
      }
      await cleanup();
    })();
    return stopPromise;
  }

  return { start, stop, register };
}

function listenHttp(server, port) {
  return new Promise((resolve, reject) => {
    const failed = error => {
      server.removeListener('listening', ready);
      reject(error);
    };
    const ready = () => {
      server.removeListener('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    try { server.listen(port); } catch (error) { failed(error); }
  });
}

function closeHttp(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') return reject(error);
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

module.exports = { createBackendLifecycle, listenHttp, closeHttp };
