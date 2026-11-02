'use strict';

const { loadSource } = require('../phase3/loadSource');
const sanitize = require('../../src/utils/sanitizeLogData');
const params = {
  entreprise_id: 'company', utilisateur_id: 'user', conge_type_id: 'type',
  annee: 2026, type: 'import_csv', quantite: '3.5', solde_apres: '12',
};

function service(error) {
  const create = jest.fn(async () => { if (error) throw error; });
  const logger = { error: jest.fn() };
  const { logMouvement } = loadSource('src/services/mouvementSoldeService.js', {
    '../models': { MouvementSolde: { create } }, '../utils/logger': logger,
    '../utils/sanitizeLogData': sanitize,
  }).exports;
  return { logMouvement, create, logger };
}

test('real service writes one movement with its transaction and numeric values', async () => {
  const s = service();
  const transaction = {};
  await s.logMouvement({ ...params, transaction });
  expect(s.create).toHaveBeenCalledTimes(1);
  expect(s.create).toHaveBeenCalledWith(expect.objectContaining({ quantite: 3.5, solde_apres: 12 }), { transaction });
});

test.each(['SequelizeDatabaseError', 'SequelizeValidationError'])(
  'real service propagates %s both inside and outside a transaction', async name => {
    const error = new Error('password=hidden-value SQL failed');
    error.name = name;
    const s = service(error);
    await expect(s.logMouvement({ ...params, transaction: {} })).rejects.toBe(error);
    await expect(s.logMouvement(params)).rejects.toBe(error);
    expect(s.create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(s.logger.error.mock.calls)).not.toContain('hidden-value');
    expect(error.name).toBe(name);
  }
);
