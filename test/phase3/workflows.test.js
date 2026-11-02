'use strict';

const { loadSource } = require('./loadSource');
const logger = { info: jest.fn(), error: jest.fn() };
const companyId = '11111111-1111-4111-8111-111111111111';

function imports() {
  const counter = { jours_reserves: 2, jours_acquis: 10, save: jest.fn().mockResolvedValue() };
  const models = {
    Entreprise: { findByPk: jest.fn().mockResolvedValue({ id: companyId }) },
    Utilisateur: { findAll: jest.fn().mockResolvedValue([{ id: 'employee', email: 'employee@test.internal' }]) },
    CongeType: { findAll: jest.fn().mockResolvedValue([{ id: 'type', libelle: 'CP' }]) },
    Conge: { findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'leave' }) },
    CompteurConges: { findOne: jest.fn().mockResolvedValue(counter) },
    sequelize: { transaction: jest.fn(async fn => fn({ simulated: true })) },
  };
  const calc = jest.fn().mockResolvedValue(3);
  const movement = jest.fn().mockResolvedValue();
  const auditImport = new Proxy({}, { get: () => jest.fn().mockResolvedValue() });
  const service = loadSource('src/controllers/congesImportController.js', {
    'csv-parse/sync': require('csv-parse/sync'), sequelize: require('sequelize'),
    '../models': models, '../services/congesService': { calcJoursConges: calc, consumeN1First: jest.fn() },
    '../services/mouvementSoldeService': { logMouvement: movement, descriptionConge: () => 'simulated' },
    '../utils/logger': logger, '../services/auditHelper': { auditImport },
    '../utils/csvDecoder': { decodeCsvBuffer: buffer => buffer.toString('utf8') },
    'iconv-lite': require('iconv-lite'),
  }).exports;
  return { service, models, counter, calc, movement };
}

function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function csvReq(extra = '') {
  return {
    user: { id: 'admin' }, body: { entreprise_id: companyId },
    file: { buffer: Buffer.from(`email,type_conge,date_debut,date_fin${extra ? ',statut' : ''}\nemployee@test.internal,CP,2027-03-01,2027-03-03${extra ? ',' + extra : ''}`) },
  };
}

test('reservation import preserves reserve, counter update and movement without SQL', async () => {
  const i = imports(), res = response(), next = jest.fn();
  await i.service.importReservationsCSV(csvReq(), res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(201);
  expect(i.models.Conge.create).toHaveBeenCalledWith(expect.objectContaining({
    entreprise_id: companyId, utilisateur_id: 'employee', statut: 'reserve', jours_calcules: 3,
  }), expect.any(Object));
  expect(i.counter.jours_reserves).toBe(5);
  expect(i.counter.save).toHaveBeenCalledTimes(1);
  expect(i.movement).toHaveBeenCalledWith(expect.objectContaining({ type: 'reservation', quantite: -3 }));
});

test('duplicate reservation import does not create or increment twice', async () => {
  const i = imports(), res = response();
  i.models.Conge.findOne.mockResolvedValue({ id: 'existing' });
  await i.service.importReservationsCSV(csvReq(), res, jest.fn());
  expect(i.models.Conge.create).not.toHaveBeenCalled();
  expect(i.counter.save).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
});

test('unknown company employee prevents reservation creation', async () => {
  const i = imports(), res = response();
  i.models.Utilisateur.findAll.mockResolvedValue([]);
  await i.service.importReservationsCSV(csvReq(), res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(422);
  expect(i.models.sequelize.transaction).not.toHaveBeenCalled();
});

test('ordinary leave import keeps pending manager status and reservation accounting', async () => {
  const i = imports(), res = response(), next = jest.fn();
  await i.service.importCongesCSV(csvReq('en_attente_manager'), res, next);
  expect(next).not.toHaveBeenCalled();
  expect(i.models.Conge.create).toHaveBeenCalledWith(expect.objectContaining({ statut: 'en_attente_manager' }), expect.any(Object));
  expect(i.counter.jours_reserves).toBe(5);
});

test('deferred monthly activation still reads reserve and deduplicates employee/type/year', async () => {
  const activate = jest.fn().mockResolvedValue({ activated: ['leave'] });
  const models = {
    Entreprise: { findAll: jest.fn().mockResolvedValue([{ id: companyId, nom: 'copy' }]) },
    Conge: { findAll: jest.fn().mockResolvedValue([
      { utilisateur_id: 'employee', conge_type_id: 'type', date_debut: '2027-03-01', annee_compteur: 2027 },
      { utilisateur_id: 'employee', conge_type_id: 'type', date_debut: '2027-04-01', annee_compteur: 2027 },
    ]) },
  };
  const accrual = jest.fn().mockResolvedValue({ applied: 1, skipped: 0, total_added: 2 });
  const cron = loadSource('src/cron/quotasCron.js', {
    '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
    '../services/cronTaskGroup': require('../../src/services/cronTaskGroup'),
    'node-cron': { schedule: jest.fn() }, '../utils/logger': logger,
    '../services/quotasService': { ajouterAcquisitionMensuelle: accrual },
    '../services/congesService': { tryActivateReservations: activate }, '../models': models,
  }).exports;
  await cron.runMonthlyAccrual();
  expect(models.Conge.findAll).toHaveBeenCalledWith(expect.objectContaining({
    where: { entreprise_id: companyId, statut: 'reserve' },
  }));
  expect(activate).toHaveBeenCalledTimes(1);
  expect(activate).toHaveBeenCalledWith('employee', 'type', 2027);
});
