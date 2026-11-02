'use strict';

const { loadSource } = require('../phase3/loadSource');
const { Op } = require('sequelize');
const dayjs = require('dayjs');

test('real reservation activation no longer resolves a rejected transaction as an activated result', async () => {
  const error = new Error('movement transaction rejected');
  const logger = { error: jest.fn() };
  const transaction = jest.fn().mockRejectedValue(error);
  const empty = {};
  const deps = {
    '../models': { sequelize: { transaction } },
    './notificationService': empty, './emailService': empty, './auditHelper': empty,
    './auditActions': empty, './mouvementSoldeService': empty, './quotasService': empty,
    './leaveNotificationRecipients': empty, './managerEventNotificationService': empty,
    './businessNotificationContext': { wrapWorkflow: fn => fn },
    './leavePolicyService': empty, './joursFeriesService': empty, './politiqueConges': empty,
    sequelize: { Op }, dayjs, 'dayjs/plugin/isSameOrBefore': require('dayjs/plugin/isSameOrBefore'),
    '../utils/validation': empty, '../utils/dateFormatter': empty, '../utils/logger': logger,
  };
  const { tryActivateReservations } = loadSource('src/services/congesService.js', deps).exports;
  await expect(tryActivateReservations('user', 'type', 2026)).rejects.toBe(error);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledTimes(1);
});

test.each([false, true])('actual quota adjustment audit waits for commit (movement failure=%s)', async fail => {
  const hooks = [];
  const events = [];
  const error = new Error('movement failed');
  const transaction = { LOCK: { UPDATE: 'UPDATE' }, afterCommit: fn => hooks.push(fn) };
  const counter = {
    entreprise_id: 'company', utilisateur_id: 'user', conge_type_id: 'type', annee: 2026,
    jours_acquis: 0, jours_reserves: 0,
    update: jest.fn(async function (v) { Object.assign(this, v); events.push('counter'); }),
  };
  const audit = jest.fn(async () => events.push('audit'));
  const { createOrUpdateCounter } = loadSource('src/services/quotasService.js', {
    '../models': {
      sequelize: { transaction: async callback => {
        const result = await callback(transaction);
        events.push('commit');
        for (const hook of hooks) await hook();
        return result;
      } },
      Utilisateur: { findOne: jest.fn().mockResolvedValue({}) },
      CongeType: { findOne: jest.fn().mockResolvedValue({}) },
      Entreprise: { findByPk: jest.fn().mockResolvedValue({}) },
      CompteurConges: { findOne: jest.fn().mockResolvedValue(counter) },
      Conge: { findAll: jest.fn().mockResolvedValue([]) },
    },
    sequelize: { Op }, './politiqueConges': { getLeaveRules: jest.fn(() => ({})) },
    './auditHelper': { auditCounter: { updated: audit } },
    '../utils/logger': { error: jest.fn() },
    './transactionSafety': require('../../src/services/transactionSafety'),
    '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
    './mouvementSoldeService': { logMouvement: async () => {
      events.push('movement');
      if (fail) throw error;
    } },
  }).exports;
  const run = createOrUpdateCounter({
    entrepriseId: 'company', utilisateurId: 'user', congeTypeId: 'type', annee: 2026,
    values: { jours_acquis: 10 },
  });
  if (fail) {
    await expect(run).rejects.toBe(error);
    expect(audit).not.toHaveBeenCalled();
  } else {
    await run;
    expect(events).toEqual(['counter', 'movement', 'commit', 'audit']);
    expect(audit).toHaveBeenCalledTimes(1);
  }
});
