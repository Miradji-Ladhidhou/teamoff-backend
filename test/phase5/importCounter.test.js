'use strict';

const { Sequelize, DataTypes } = require('sequelize');
const { loadSource } = require('../phase3/loadSource');

const where = {
  entreprise_id: '11111111-1111-4111-8111-111111111111',
  utilisateur_id: '22222222-2222-4222-8222-222222222222',
  conge_type_id: '33333333-3333-4333-8333-333333333333',
  annee: 2026,
};
const transaction = () => ({ LOCK: { UPDATE: 'UPDATE' } });

function setup() {
  const db = new Sequelize('postgres://offline:offline@127.0.0.1/offline', { logging: false });
  const Counter = require('../../src/models/CompteurConges')(db, DataTypes);
  const query = jest.fn().mockResolvedValue([]);
  const counter = { jours_acquis: 25, jours_reserves: 4 };
  jest.spyOn(Counter, 'findOne').mockResolvedValue(counter);
  const { getImportCounter } = loadSource('src/services/importCounterService.js', {
    '../models': { CompteurConges: Counter, sequelize: { query } },
  }).exports;
  return { getImportCounter, Counter, query, counter, db };
}

test('DML insert targets the exact unique key and returns a locked model in the caller transaction', async () => {
  const s = setup();
  const t = transaction();
  expect(await s.getImportCounter(where, t)).toBe(s.counter);
  const [sql, options] = s.query.mock.calls[0];
  expect(sql).toMatch(/ON CONFLICT \(entreprise_id, utilisateur_id, conge_type_id, annee\)\s+DO NOTHING/);
  expect(sql).not.toMatch(/\b(CREATE|DROP|ALTER|FUNCTION|pg_temp)\b/i);
  expect(options.transaction).toBe(t);
  expect(options.bind).toEqual({
    id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    entrepriseId: where.entreprise_id, utilisateurId: where.utilisateur_id,
    congeTypeId: where.conge_type_id, annee: where.annee,
  });
  expect(s.Counter.findOne).toHaveBeenCalledWith({ where, transaction: t, lock: 'UPDATE' });
  expect(s.counter).toEqual({ jours_acquis: 25, jours_reserves: 4 });
  await s.db.close();
});

test('two concurrent creations wait for the winning commit and return one counter without resetting balances', async () => {
  const s = setup();
  const first = transaction();
  const second = transaction();
  let commit;
  const committed = new Promise(resolve => { commit = resolve; });
  let inserted = 0;
  s.query.mockImplementation(async (_, options) => {
    if (options.transaction === first) inserted++;
    else await committed;
  });
  const winning = s.getImportCounter(where, first);
  const waiting = s.getImportCounter(where, second);
  const a = await winning;
  a.jours_acquis = 31;
  commit();
  const b = await waiting;
  expect(b).toBe(a);
  expect(b.jours_acquis).toBe(31);
  expect(inserted).toBe(1);
  expect(s.Counter.findOne.mock.calls.map(call => call[0].transaction)).toEqual([first, second]);
  await s.db.close();
});

test('rollback of a conflicting writer permits the waiting insert rather than returning a phantom row', async () => {
  const s = setup();
  let rollback;
  const rolledBack = new Promise(resolve => { rollback = resolve; });
  s.query.mockImplementation(async () => { await rolledBack; });
  const pending = s.getImportCounter(where, transaction());
  expect(s.Counter.findOne).not.toHaveBeenCalled();
  rollback();
  expect(await pending).toBe(s.counter);
  await s.db.close();
});

test.each(['23505', '40001', '55P03', 'connection-lost'])(
  'database failure %s is propagated unchanged without retry or a successful fallback', async code => {
    const s = setup();
    const error = Object.assign(new Error(code), { code });
    s.query.mockRejectedValue(error);
    await expect(s.getImportCounter(where, transaction())).rejects.toBe(error);
    expect(s.query).toHaveBeenCalledTimes(1);
    expect(s.Counter.findOne).not.toHaveBeenCalled();
    await s.db.close();
  }
);

test('a row deleted before the reread fails explicitly', async () => {
  const s = setup();
  s.Counter.findOne.mockResolvedValue(null);
  await expect(s.getImportCounter(where, transaction())).rejects.toThrow(/introuvable/);
  await s.db.close();
});

test('locked reread errors are propagated to the caller transaction', async () => {
  const s = setup();
  const error = new Error('row lock timeout');
  s.Counter.findOne.mockRejectedValue(error);
  await expect(s.getImportCounter(where, transaction())).rejects.toBe(error);
  expect(s.query).toHaveBeenCalledTimes(1);
  await s.db.close();
});

test('validation and missing transaction fail before SQL', async () => {
  const s = setup();
  await expect(s.getImportCounter(where)).rejects.toThrow(/Transaction obligatoire/);
  await expect(s.getImportCounter({ ...where, annee: 1999 }, transaction())).rejects.toThrow();
  expect(s.query).not.toHaveBeenCalled();
  await s.db.close();
});

test('different counters receive unique UUIDs and all identifying fields are bound, never interpolated', async () => {
  const s = setup();
  await s.getImportCounter(where, transaction());
  await s.getImportCounter({ ...where, annee: 2027 }, transaction());
  expect(s.query.mock.calls[0][1].bind.id).not.toBe(s.query.mock.calls[1][1].bind.id);
  expect(s.query.mock.calls[0][0]).not.toContain(where.entreprise_id);
  await s.db.close();
});

test('model and historical index agree on the four-column unique key', () => {
  const s = setup();
  expect(s.Counter.options.uniqueKeys.compteur_unique.fields).toEqual(Object.keys(where));
  const migration = require('fs').readFileSync(require('path').resolve(
    __dirname, '../../migrations/20260101000000-baseline.js'), 'utf8');
  expect(migration).toContain('("entreprise_id", "utilisateur_id", "conge_type_id", "annee")');
  return s.db.close();
});
