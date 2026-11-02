'use strict';

const { Sequelize, DataTypes } = require('sequelize');
const { loadSource } = require('../phase3/loadSource');
const sequelize = new Sequelize('offline', 'offline', 'offline', { dialect: 'postgres', logging: false });
const Model = require('../../src/models/Utilisateur')(sequelize, DataTypes);
const values = {
  nom: 'Nom', prenom: 'Prenom', email: 'employee@example.invalid', role: 'employe',
  service: null, entreprise_id: '11111111-1111-4111-8111-111111111111',
  date_embauche: null, password_hash: 'placeholder', invite_token_hash: 'invitation', statut: 'en_attente',
};

function setup() {
  let committed;
  let pending;
  const transactions = () => {
    const t = { LOCK: { UPDATE: 'UPDATE' } };
    t.finish = success => {
      if (pending?.transaction === t) {
        if (success) committed = pending.user;
        const resolve = pending.resolve;
        pending = null;
        resolve();
      }
    };
    return t;
  };
  const findOne = jest.fn(async ({ transaction }) =>
    committed || (pending?.transaction === transaction ? pending.user : null));
  const query = jest.fn(async (sql, { bind, transaction }) => {
    expect(sql).toContain('ON CONFLICT (email) DO NOTHING RETURNING id');
    while (pending && pending.transaction !== transaction) await pending.done;
    if (committed) return [[], { command: 'INSERT' }];
    let resolve;
    const done = new Promise(r => { resolve = r; });
    pending = { transaction, user: { ...bind }, done, resolve };
    return [[{ id: bind.id }], { command: 'INSERT' }];
  });
  const { getImportUser } = loadSource('src/services/importUserService.js', {
    '../models': { Utilisateur: { build: v => Model.build(v), findOne }, sequelize: { query } },
  }).exports;
  return { getImportUser, query, findOne, transactions, setExisting: user => { committed = user; } };
}

test('validates real model and emits only bound DML, no temporary function', async () => {
  const s = setup();
  const t = s.transactions();
  const result = await s.getImportUser(values, t);
  expect(result.created).toBe(true);
  expect(result.user.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(s.query).toHaveBeenCalledTimes(1);
  expect(s.query.mock.calls[0][0]).not.toMatch(/CREATE|FUNCTION|pg_temp|testfunc/);
  expect(s.findOne.mock.calls.every(([options]) => options.transaction === t && options.lock === 'UPDATE')).toBe(true);
});

test.each(['same company', 'another company'])('two concurrent creations (%s) use one winner and never overwrite its invitation', async scope => {
  const s = setup();
  const first = s.transactions();
  const second = s.transactions();
  const p1 = s.getImportUser(values, first);
  const other = { ...values, invite_token_hash: 'loser-token' };
  if (scope === 'another company') other.entreprise_id = '22222222-2222-4222-8222-222222222222';
  const p2 = s.getImportUser(other, second);
  const winner = await p1;
  first.finish(true);
  const loser = await p2;
  expect(winner.created).toBe(true);
  expect(loser.created).toBe(false);
  expect(loser.user.id).toBe(winner.user.id);
  expect(loser.user.entreprise_id).toBe(values.entreprise_id);
  expect(loser.user.invite_token_hash).toBe('invitation');
  expect(s.query).toHaveBeenCalledTimes(2);
});

test('a rolled-back concurrent creator leaves the second creation eligible', async () => {
  const s = setup();
  const first = s.transactions();
  const second = s.transactions();
  const p1 = s.getImportUser(values, first);
  const p2 = s.getImportUser(values, second);
  await p1;
  first.finish(false);
  expect((await p2).created).toBe(true);
});

test('existing account is returned without insert or invitation replacement', async () => {
  const s = setup();
  const user = { ...values, id: 'existing', invite_token_hash: 'keep' };
  s.setExisting(user);
  expect(await s.getImportUser(values, s.transactions())).toEqual({ user, created: false });
  expect(s.query).not.toHaveBeenCalled();
});

test('missing transaction, validation failure and SQL failure propagate without retry', async () => {
  const s = setup();
  await expect(s.getImportUser(values)).rejects.toThrow(/Transaction obligatoire/);
  await expect(s.getImportUser({ ...values, nom: null }, s.transactions())).rejects.toMatchObject({ name: 'SequelizeValidationError' });
  expect(s.query).not.toHaveBeenCalled();
  const error = new Error('unique constraint missing');
  s.query.mockRejectedValue(error);
  await expect(s.getImportUser(values, s.transactions())).rejects.toBe(error);
  expect(s.query).toHaveBeenCalledTimes(1);
});

test('missing winner is an explicit failure, never a synthetic employee', async () => {
  const s = setup();
  s.findOne.mockResolvedValue(null);
  s.query.mockResolvedValue([[], {}]);
  await expect(s.getImportUser(values, s.transactions())).rejects.toThrow(/introuvable/);
});
