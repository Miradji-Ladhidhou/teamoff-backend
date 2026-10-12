'use strict';

const bcrypt = require('bcrypt');
const { Entreprise, Utilisateur, Absence } = require('../src/models');
const { listAbsences } = require('../src/services/absenceService');
const { getCalendrier } = require('../src/controllers/calendrierController');
const ExportService = require('../src/services/exportService');
const { canManagerViewAllAbsences } = require('../src/services/politiqueConges');
const request = require('supertest');
const app = require('../src/index');
const { generateToken } = require('./helpers/auth');

const runId = Date.now();
let entreprise, otherEntreprise, manager, employeeRH, employeeIT, otherEmployee;
let localAbsence, crossAbsence, otherAbsence;

beforeAll(async () => {
  const password_hash = await bcrypt.hash('Test1234!', 10);
  entreprise = await Entreprise.create({ nom: `AbsenceScope_${runId}`, politique_conges: {}, parametres: {}, statut: 'active' });
  otherEntreprise = await Entreprise.create({ nom: `OtherAbsenceScope_${runId}`, politique_conges: {}, parametres: {}, statut: 'active' });
  const createUser = (name, service, companyId, role = 'employe') => Utilisateur.create({
    entreprise_id: companyId, prenom: name, nom: 'Scope', service, role,
    email: `${name}.absence.scope.${runId}@test.internal`, password_hash, statut: 'actif',
  });
  manager = await createUser('manager', 'RH', entreprise.id, 'manager');
  employeeRH = await createUser('local', 'RH', entreprise.id);
  employeeIT = await createUser('cross', 'IT', entreprise.id);
  otherEmployee = await createUser('other', 'IT', otherEntreprise.id);
  const createAbsence = (employee, type_absence) => Absence.create({
    entreprise_id: employee.entreprise_id, utilisateur_id: employee.id, type_absence,
    date_debut: '2027-04-01', date_fin: '2027-04-02', commentaire: 'Test scope',
  });
  localAbsence = await createAbsence(employeeRH, 'absence_exceptionnelle');
  crossAbsence = await createAbsence(employeeIT, 'maladie');
  otherAbsence = await createAbsence(otherEmployee, 'maladie');
});

afterAll(async () => {
  for (const company of [entreprise, otherEntreprise]) {
    if (!company) continue;
    await Absence.destroy({ where: { entreprise_id: company.id } });
    await Utilisateur.destroy({ where: { entreprise_id: company.id } });
    await company.destroy();
  }
});

async function setPermissions(absences, leaves = false) {
  await entreprise.update({ politique_conges: { service_policies: {
    RH: { manager_can_view_all_absences: absences, manager_can_view_all_services: leaves },
    IT: { manager_can_view_all_absences: true },
  } } });
}

async function calendar(query = {}) {
  const response = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  await getCalendrier({
    user: manager, params: { year: '2027', month: '4' }, query,
  }, response, error => { throw error; });
  return response;
}

test('la permission exige un booléen explicite sur le service du manager', () => {
  const rules = { service_policies: {
    RH: { manager_can_view_all_absences: true },
    IT: { manager_can_view_all_absences: 'true' },
  } };
  expect(canManagerViewAllAbsences(rules, { service: 'RH' })).toBe(true);
  expect(canManagerViewAllAbsences(rules, { service: 'IT' })).toBe(false);
  expect(canManagerViewAllAbsences(rules, { service: null })).toBe(false);
  expect(canManagerViewAllAbsences({}, { service: 'RH' })).toBe(false);
});

test('désactivé : liste et calendrier limités au service même si la visibilité des congés est activée', async () => {
  await setPermissions(false, true);
  const rows = await listAbsences(manager, {});
  expect(rows.map(row => row.id)).toEqual([localAbsence.id]);
  await expect(listAbsences(manager, { utilisateur_id: employeeIT.id })).rejects.toMatchObject({ status: 403 });
  const response = await calendar();
  expect(response.json.mock.calls[0][0].filter(row => row.record_type === 'absence').map(row => row.id)).toEqual([localAbsence.id]);
});

test('activé : voit les deux types d’absence sans sortir de l’entreprise ni élargir les congés', async () => {
  await setPermissions(true);
  const rows = await listAbsences(manager, {});
  expect(rows.map(row => row.id)).toEqual(expect.arrayContaining([localAbsence.id, crossAbsence.id]));
  expect(rows).toHaveLength(2);
  expect(rows.map(row => row.id)).not.toContain(otherAbsence.id);
  const response = await calendar();
  expect(response.json.mock.calls[0][0].map(row => row.id)).toEqual(expect.arrayContaining([localAbsence.id, crossAbsence.id]));
  expect(response.json.mock.calls[0][0].map(row => row.id)).not.toContain(otherAbsence.id);
  const leaveWhere = await ExportService.getExportUserWhere(entreprise.id, {}, manager);
  expect(leaveWhere[require('sequelize').Op.and]).toContainEqual({ service: 'RH' });
});

test('le filtre collaborateur reste exact dans la liste et le calendrier', async () => {
  await setPermissions(true);
  expect((await listAbsences(manager, { utilisateur_id: employeeIT.id })).map(row => row.id)).toEqual([crossAbsence.id]);
  const response = await calendar({ utilisateurId: employeeIT.id });
  expect(response.json.mock.calls[0][0].map(row => row.id)).toEqual([crossAbsence.id]);
  const localResponse = await calendar({ utilisateurId: employeeRH.id });
  expect(localResponse.json.mock.calls[0][0].map(row => row.id)).toEqual([localAbsence.id]);
});

test('les exports exceptionnels et maladie suivent la permission et sa révocation', async () => {
  await setPermissions(false, true);
  expect((await ExportService.getArretsMaladiePreview(entreprise.id, {}, 50, manager)).rows).toHaveLength(0);
  expect((await ExportService.getAbsencesPreview(entreprise.id, {}, 50, manager)).rows).toHaveLength(1);
  await setPermissions(true);
  const medical = await ExportService.getArretsMaladiePreview(entreprise.id, {}, 50, manager);
  expect(medical.rows).toHaveLength(1);
  expect(medical.rows[0].email).toBe(employeeIT.email);
  const exceptional = await ExportService.getAbsencesPreview(entreprise.id, {}, 50, manager);
  expect(exceptional.rows).toHaveLength(1);
  expect(exceptional.rows[0].email).toBe(employeeRH.email);
  await setPermissions(false);
  expect((await listAbsences(manager, {})).map(row => row.id)).toEqual([localAbsence.id]);
  expect((await ExportService.getArretsMaladiePreview(entreprise.id, {}, 50, manager)).rows).toHaveLength(0);
});

test('les employés restent limités à leurs absences et les admins voient toute leur entreprise', async () => {
  await setPermissions(true);
  expect((await listAbsences(employeeRH, {})).map(row => row.id)).toEqual([localAbsence.id]);
  const rows = await listAbsences({ role: 'admin_entreprise', id: manager.id, entreprise_id: entreprise.id }, {});
  expect(rows).toHaveLength(2);
  expect(rows.map(row => row.id)).not.toContain(otherAbsence.id);
});

test('les catégories maladie et exceptionnelle ont des portées de lecture différentes', async () => {
  await entreprise.update({ politique_conges: { service_policies: { RH: {
    manager_cross_service: {
      maladie: { view: true, email: false, in_app: false, participation: 'information' },
      absence_exceptionnelle: { view: false, email: true, in_app: true, participation: 'information' },
    },
  } } } });
  const exceptional = await Absence.create({
    entreprise_id: entreprise.id, utilisateur_id: employeeIT.id, type_absence: 'absence_exceptionnelle',
    date_debut: '2027-04-05', date_fin: '2027-04-05', commentaire: 'Test privé',
  });
  try {
    const ids = (await listAbsences(manager, {})).map(row => row.id);
    expect(ids).toContain(crossAbsence.id);
    expect(ids).toContain(localAbsence.id);
    expect(ids).not.toContain(exceptional.id);
    const events = (await calendar()).json.mock.calls[0][0];
    expect(events.map(row => row.id)).toContain(crossAbsence.id);
    expect(events.map(row => row.id)).not.toContain(exceptional.id);
    const exported = await ExportService.getAbsencesPreview(entreprise.id, {}, 50, manager);
    expect(exported.rows).toHaveLength(1);
    expect(exported.rows[0].email).toBe(employeeRH.email);
    expect((await ExportService.getArretsMaladiePreview(entreprise.id, {}, 50, manager)).rows).toHaveLength(1);
  } finally {
    await exceptional.destroy();
  }
});

test('information seule ne permet aucune action interservices, même via l’API directe', async () => {
  await entreprise.update({ politique_conges: { service_policies: { RH: { manager_cross_service: {
    maladie: { view: true, email: true, in_app: true, participation: 'information' },
  } } } } });
  const token = generateToken(manager);
  const patch = await request(app).patch(`/api/absences/${crossAbsence.id}`)
    .set('Authorization', `Bearer ${token}`).send({ statut: 'approuvée' });
  expect(patch.status).toBe(403);
  const remove = await request(app).delete(`/api/absences/${crossAbsence.id}`)
    .set('Authorization', `Bearer ${token}`);
  expect(remove.status).toBe(403);
  const create = await request(app).post('/api/absences')
    .set('Authorization', `Bearer ${token}`).send({
      utilisateur_id: employeeIT.id, type_absence: 'maladie',
      date_debut: '2027-05-05', date_fin: '2027-05-05', commentaire: 'Test',
    });
  expect(create.status).toBe(403);
  expect((await Absence.findByPk(crossAbsence.id)).statut).toBe('signalée');
});

test('peut agir autorise le traitement existant pour la seule catégorie sélectionnée', async () => {
  await entreprise.update({ politique_conges: { service_policies: { RH: { manager_cross_service: {
    maladie: { view: true, email: false, in_app: false, participation: 'action' },
    absence_exceptionnelle: { view: true, email: true, in_app: true, participation: 'information' },
  } } } } });
  const token = generateToken(manager);
  try {
    const patch = await request(app).patch(`/api/absences/${crossAbsence.id}`)
      .set('Authorization', `Bearer ${token}`).send({ statut: 'approuvée' });
    expect(patch.status).toBe(200);
    expect(patch.body.statut).toBe('approuvée');
    await expect(require('../src/services/absenceService').assertManagerAbsenceAction(manager, employeeIT.id, 'absence_exceptionnelle'))
      .rejects.toMatchObject({ status: 403 });
  } finally {
    await crossAbsence.reload();
    await crossAbsence.update({ statut: 'signalée' });
  }
});
