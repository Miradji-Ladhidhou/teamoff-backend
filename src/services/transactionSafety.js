'use strict';

const logger = require('../utils/logger');
const { sanitizeError } = require('../utils/sanitizeLogData');

const states = new WeakMap();
const installed = new WeakSet();

function stateFor(transaction) {
  if (!states.has(transaction)) states.set(transaction, { committed: false });
  return states.get(transaction);
}

function secondary(primary, error) {
  if (primary === error || primary.cleanupErrors?.includes(error)) return;
  sanitizeError(error);
  primary.cleanupErrors = [...(primary.cleanupErrors || []), error];
  logger.error('transaction_cleanup_failed', { error: error.message });
}

async function rollbackAfterError(transaction, error) {
  sanitizeError(error);
  if (isTransactionCommitted(transaction)) error.transactionCommitted = true;
  if (!transaction.finished) {
    try { await transaction.rollback(); } catch (cleanupError) {
      secondary(error, cleanupError);
    }
  }
}

function isTransactionCommitted(transaction) {
  return states.get(transaction)?.committed === true;
}

function protectTransaction(transaction) {
  const state = stateFor(transaction);
  if (state.protected) return;
  state.protected = true;
  const afterCommit = transaction.afterCommit.bind(transaction);
  transaction.afterCommit = fn => {
    if (typeof fn !== 'function') return afterCommit(fn);
    return afterCommit(async function (...args) {
      // Sequelize 6.37 runs these hooks in commit's finally, even on failure.
      if (state.committed) {
        try { return await fn.apply(this, args); } catch (error) {
          sanitizeError(error);
          state.afterCommitErrors = [...(state.afterCommitErrors || []), error];
          logger.error('transaction_after_commit_failed', { error: error.message });
        }
        return;
      }
      if (transaction.parent && transaction.finished === 'commit') {
        return transaction.parent.afterCommit(() => fn.apply(this, args));
      }
    });
  };
  // Retain cleanup failures (including an asynchronous release adapter) and
  // settle them below, without changing which connection Sequelize releases.
  transaction.cleanup = () => {
    if (transaction.parent || transaction.connection.uuid === undefined) return;
    transaction._clearCls();
    const connection = transaction.connection;
    connection.uuid = undefined;
    state.release = Promise.resolve().then(() =>
      transaction.sequelize.connectionManager.releaseConnection(connection)).catch(async error => {
      sanitizeError(error);
      try { await transaction.sequelize.connectionManager.destroyConnection(connection); } catch (cleanupError) {
        secondary(error, cleanupError);
      }
      throw error;
    });
    state.release.catch(error => {
      state.releaseError = sanitizeError(error);
      logger.error('transaction_release_failed', { error: state.releaseError.message });
    });
  };
  for (const method of ['commit', 'rollback']) {
    const original = transaction[method].bind(transaction);
    transaction[method] = async (...args) => {
      if (transaction.finished) return original(...args);
      let primary;
      try {
        await original(...args);
      } catch (error) {
        primary = state[`${method}Error`] || error;
        sanitizeError(primary);
        if (error !== primary) secondary(primary, error);
      }
      if (method === 'commit' && state.afterCommitErrors?.length) {
        const [first, ...remaining] = state.afterCommitErrors;
        if (primary) secondary(primary, first);
        else primary = first;
        primary.afterCommitErrors = remaining;
      }
      if (state.release) {
        try { await state.release; } catch (error) {
          if (primary) secondary(primary, error);
          else primary = sanitizeError(error);
        }
      }
      if (primary) {
        if (state.committed) primary.transactionCommitted = true;
        throw primary;
      }
    };
  }
}

function installTransactionSafety(sequelize) {
  if (installed.has(sequelize)) return;
  installed.add(sequelize);
  const Query = sequelize.dialect.Query;
  sequelize.dialect.Query = class ConfirmedPostgresQuery extends Query {
    async run(sql, parameters) {
      const command = sql.trim().replace(/;$/, '').toUpperCase();
      const transaction = this.options.transaction;
      const completion = transaction && this.options.completesTransaction
        && ['COMMIT', 'ROLLBACK'].includes(command);
      if (completion) this.options.type = 'RAW';
      try {
        const result = await super.run(sql, parameters);
        if (completion) {
          const state = stateFor(transaction);
          if (!Array.isArray(result) || result[1]?.command !== command) {
            throw new Error(`PostgreSQL ${command} non confirmé par le résultat du driver.`);
          }
          if (command === 'COMMIT') state.committed = true;
        }
        return result;
      } catch (error) {
        sanitizeError(error);
        if (completion) stateFor(transaction)[`${command.toLowerCase()}Error`] = error;
        throw error;
      }
    }
  };

  // Keep Sequelize's native managed transaction/CLS/savepoint lifecycle.
  const original = sequelize.transaction.bind(sequelize);
  sequelize.transaction = async (options, callback) => {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (!callback) {
      const transaction = await original(options);
      protectTransaction(transaction);
      return transaction;
    }
    let bodyError;
    let transaction;
    try {
      return await original(options, async t => {
        transaction = t;
        protectTransaction(t);
        try { return await callback(t); } catch (error) {
          bodyError = sanitizeError(error);
          throw bodyError;
        }
      });
    } catch (error) {
      const primary = bodyError || error;
      const rollbackError = transaction && (stateFor(transaction).rollbackError || stateFor(transaction).releaseError);
      if (bodyError && rollbackError) secondary(primary, rollbackError);
      if (primary !== error) secondary(primary, error);
      throw sanitizeError(primary);
    }
  };
}

module.exports = { installTransactionSafety, rollbackAfterError, isTransactionCommitted };
