'use strict';

const bcrypt = require('bcrypt');
const dayjs = require('dayjs');
const {
  Entreprise,
  Utilisateur,
  CongeType,
  CompteurConges,
  Conge,
  CongeImputation,
  MouvementSolde,
  Notification,
} = require('../src/models');
const {
  createConge,
  activerReservation,
  tryActivateReservations,
  validerConge,
} = require('../src/services/congesService');

const RUN_ID = Date.now();
const CURRENT_YEAR = dayjs().year();
const NEXT_YEAR = CURRENT_YEAR + 1;
const DATE_START = `${NEXT_YEAR}-10-04`;
const DATE_END = `${NEXT_YEAR}-10-08`;
const createdCompanyIds = [];

async function createFixture(label, approvalWorkflow = 'manager_admin', allowReservation = true) {
  const passwordHash = await bcrypt.hash('Test1234!', 10);
  const company = await Entreprise.create({
    nom: `NewLeave_${label}_${RUN_ID}`,
    politique_conges: {
      approval_workflow: approvalWorkflow,
      autoriser_reservation_sans_solde: allowReservation,
      blocked_days: { exclude_weekends: false, exclude_holidays: false },
      notification_settings: { on_create: true, on_validate: true, on_reject: true },
    },
    parametres: {},
    statut: 'active',
  });
  createdCompanyIds.push(company.id);

  const [employee, manager, admin] = await Promise.all([
    Utilisateur.create({
      entreprise_id: company.id,
      prenom: 'Employee', nom: label,
      email: `employee.${label}.${RUN_ID}@test.internal`,
      role: 'employe', password_hash: passwordHash, statut: 'actif',
    }),
    Utilisateur.create({
      entreprise_id: company.id,
      prenom: 'Manager', nom: label,
      email: `manager.${label}.${RUN_ID}@test.internal`,
      role: 'manager', password_hash: passwordHash, statut: 'actif',
    }),
    Utilisateur.create({
      entreprise_id: company.id,
      prenom: 'Admin', nom: label,
      email: `admin.${label}.${RUN_ID}@test.internal`,
      role: 'admin_entreprise', password_hash: passwordHash, statut: 'actif',
    }),
  ]);
  const leaveType = await CongeType.create({
    entreprise_id: company.id,
    libelle: `CP_${label}_${RUN_ID}`,
    code: `N${label.slice(0, 2).toUpperCase()}${String(RUN_ID).slice(-6)}`,
    deductible: true,
    demi_journee_autorisee: false,
  });

  return { company, employee, manager, admin, leaveType };
}

async function createCounter(fixture, year, acquired, reserved = 0) {
  return CompteurConges.create({
    entreprise_id: fixture.company.id,
    utilisateur_id: fixture.employee.id,
    conge_type_id: fixture.leaveType.id,
    annee: year,
    jours_acquis: acquired,
    jours_pris: 0,
    jours_reserves: reserved,
  });
}

async function createFutureLeave(fixture, extra = {}) {
  return createConge({
    conge_type_id: fixture.leaveType.id,
    date_debut: DATE_START,
    date_fin: DATE_END,
    reqUser: fixture.employee,
    ...extra,
  });
}

afterAll(async () => {
  if (createdCompanyIds.length) {
    await Entreprise.destroy({ where: { id: createdCompanyIds } }).catch(() => {});
  }
});

describe('Nouvelles demandes de réservation N+1', () => {
  it('crée sans compteur préalable, active dans le workflow manager_admin et impute du plus ancien au plus récent', async () => {
    const fixture = await createFixture('ManagerAdmin');
    await createCounter(fixture, CURRENT_YEAR - 1, 3);
    await createCounter(fixture, CURRENT_YEAR, 2);

    const leave = await createFutureLeave(fixture);
    expect(leave.statut).toBe('reserve');
    expect(leave.annee_compteur).toBe(NEXT_YEAR);

    const futureCounter = await CompteurConges.findOne({
      where: {
        utilisateur_id: fixture.employee.id,
        conge_type_id: fixture.leaveType.id,
        annee: NEXT_YEAR,
      },
    });
    expect(Number(futureCounter.jours_acquis)).toBe(0);
    expect(Number(futureCounter.jours_reserves)).toBe(5);

    const creationNotifications = await Notification.findAll({
      where: { utilisateur_id: fixture.employee.id, url: `/conges/${leave.id}` },
    });
    expect(creationNotifications.map((notification) => notification.type)).toContain('conge_cree');

    await activerReservation(leave.id, fixture.admin);
    let savedLeave = await Conge.findByPk(leave.id);
    expect(savedLeave.statut).toBe('en_attente_manager');
    expect(Number((await CompteurConges.findByPk(futureCounter.id)).jours_reserves)).toBe(5);

    const activationNotifications = await Notification.findAll({
      where: { url: `/conges/${leave.id}` },
    });
    expect(activationNotifications.some((notification) =>
      notification.utilisateur_id === fixture.employee.id && notification.type === 'conge_demande'
    )).toBe(true);
    for (const recipient of [fixture.manager, fixture.admin]) {
      expect(activationNotifications.some((notification) =>
        notification.utilisateur_id === recipient.id && notification.type === 'conge_reserve_active'
      )).toBe(true);
    }

    await validerConge(leave.id, fixture.manager, 'Approbation manager');
    savedLeave = await Conge.findByPk(leave.id);
    expect(savedLeave.statut).toBe('valide_manager');
    await validerConge(leave.id, fixture.admin, 'Validation finale');

    savedLeave = await Conge.findByPk(leave.id);
    const counters = await CompteurConges.findAll({
      where: { utilisateur_id: fixture.employee.id, conge_type_id: fixture.leaveType.id },
      order: [['annee', 'ASC']],
    });
    const imputations = await CongeImputation.findAll({
      where: { conge_id: leave.id },
      order: [['annee', 'ASC']],
    });
    expect(savedLeave.statut).toBe('valide_final');
    expect(counters.map((counter) => Number(counter.jours_pris))).toEqual([3, 2, 0]);
    expect(Number(counters[2].jours_reserves)).toBe(0);
    expect(imputations.map((row) => [row.annee, Number(row.jours)])).toEqual([
      [CURRENT_YEAR - 1, 3],
      [CURRENT_YEAR, 2],
    ]);

    const finalNotifications = await Notification.findAll({
      where: { utilisateur_id: fixture.employee.id, url: `/conges/${leave.id}` },
    });
    expect(finalNotifications.some((notification) => notification.type === 'conge_valide_final')).toBe(true);
  });

  it('ne valide pas si le total reste insuffisant et conserve statut et compteurs', async () => {
    const fixture = await createFixture('Insufficient');
    await createCounter(fixture, CURRENT_YEAR, 4);

    const leave = await createFutureLeave(fixture);
    await activerReservation(leave.id, fixture.admin);
    await validerConge(leave.id, fixture.manager, 'Approbation manager');

    await expect(
      validerConge(leave.id, fixture.admin, 'Validation finale')
    ).rejects.toMatchObject({ statusCode: 422 });

    const savedLeave = await Conge.findByPk(leave.id);
    const counters = await CompteurConges.findAll({
      where: { utilisateur_id: fixture.employee.id, conge_type_id: fixture.leaveType.id },
      order: [['annee', 'ASC']],
    });
    expect(savedLeave.statut).toBe('valide_manager');
    expect(counters.map((counter) => [
      Number(counter.jours_acquis),
      Number(counter.jours_pris),
      Number(counter.jours_reserves),
    ])).toEqual([[4, 0, 0], [0, 0, 5]]);
    expect(await CongeImputation.count({ where: { conge_id: leave.id } })).toBe(0);
    expect(await MouvementSolde.count({
      where: { source_id: leave.id, type: 'validation' },
    })).toBe(0);
  });

  it('active et valide automatiquement une nouvelle réservation après crédit sur les anciens compteurs', async () => {
    const fixture = await createFixture('AutoAfterCredit', 'auto');
    const leave = await createFutureLeave(fixture);
    expect(leave.statut).toBe('reserve');

    await createCounter(fixture, CURRENT_YEAR - 1, 3);
    await createCounter(fixture, CURRENT_YEAR, 2);
    const result = await tryActivateReservations(
      fixture.employee.id,
      fixture.leaveType.id,
      NEXT_YEAR
    );

    const savedLeave = await Conge.findByPk(leave.id);
    const imputations = await CongeImputation.findAll({
      where: { conge_id: leave.id },
      order: [['annee', 'ASC']],
    });
    expect(result.error).toBeUndefined();
    expect(result.activated.map((item) => item.conge_id)).toContain(leave.id);
    expect(savedLeave.statut).toBe('valide_final');
    expect(imputations.map((row) => [row.annee, Number(row.jours)])).toEqual([
      [CURRENT_YEAR - 1, 3],
      [CURRENT_YEAR, 2],
    ]);
  });

  it('laisse en réservation une demande auto si le solde cumulé est insuffisant', async () => {
    const fixture = await createFixture('AutoInsufficient', 'auto');
    await createCounter(fixture, CURRENT_YEAR, 4);
    const leave = await createFutureLeave(fixture);

    const result = await tryActivateReservations(
      fixture.employee.id,
      fixture.leaveType.id,
      NEXT_YEAR
    );
    const savedLeave = await Conge.findByPk(leave.id);
    const currentCounter = await CompteurConges.findOne({
      where: {
        utilisateur_id: fixture.employee.id,
        conge_type_id: fixture.leaveType.id,
        annee: CURRENT_YEAR,
      },
    });
    const futureCounter = await CompteurConges.findOne({
      where: {
        utilisateur_id: fixture.employee.id,
        conge_type_id: fixture.leaveType.id,
        annee: NEXT_YEAR,
      },
    });

    expect(result.activated).toHaveLength(0);
    expect(result.still_pending).toHaveLength(1);
    expect(result.still_pending[0].solde_manquant).toBe(1);
    expect(savedLeave.statut).toBe('reserve');
    expect(Number(currentCounter.jours_acquis)).toBe(4);
    expect(Number(currentCounter.jours_pris)).toBe(0);
    expect(Number(futureCounter.jours_reserves)).toBe(5);
    expect(await CongeImputation.count({ where: { conge_id: leave.id } })).toBe(0);
    expect(await MouvementSolde.count({
      where: { source_id: leave.id, type: 'validation' },
    })).toBe(0);
  });

  it('valide immédiatement en workflow auto quand le compteur N+1 couvre la demande', async () => {
    const fixture = await createFixture('AutoImmediate', 'auto');
    await createCounter(fixture, NEXT_YEAR, 5);

    const leave = await createFutureLeave(fixture);
    const savedLeave = await Conge.findByPk(leave.id);
    const futureCounter = await CompteurConges.findOne({
      where: {
        utilisateur_id: fixture.employee.id,
        conge_type_id: fixture.leaveType.id,
        annee: NEXT_YEAR,
      },
    });

    expect(savedLeave.statut).toBe('valide_final');
    expect(Number(futureCounter.jours_acquis)).toBe(0);
    expect(Number(futureCounter.jours_pris)).toBe(5);
    expect(await CongeImputation.count({ where: { conge_id: leave.id, annee: NEXT_YEAR } })).toBe(1);
  });

  it('respecte le workflow admin_only et ne notifie pas le manager lors de l’activation', async () => {
    const fixture = await createFixture('AdminOnly', 'admin_only');
    const leave = await createFutureLeave(fixture);

    await activerReservation(leave.id, fixture.admin);

    const activationNotifications = await Notification.findAll({
      where: { url: `/conges/${leave.id}` },
    });
    expect((await Conge.findByPk(leave.id)).statut).toBe('en_attente_manager');
    expect(activationNotifications.some((notification) =>
      notification.utilisateur_id === fixture.admin.id && notification.type === 'conge_reserve_active'
    )).toBe(true);
    expect(activationNotifications.some((notification) =>
      notification.utilisateur_id === fixture.manager.id && notification.type === 'conge_reserve_active'
    )).toBe(false);
  });

  it('refuse une réservation N+1 si la politique la désactive', async () => {
    const fixture = await createFixture('DisabledReservation', 'manager_admin', false);

    await expect(createFutureLeave(fixture)).rejects.toMatchObject({ status: 422 });
    expect(await Conge.count({ where: { utilisateur_id: fixture.employee.id } })).toBe(0);
    expect(await CompteurConges.count({ where: { utilisateur_id: fixture.employee.id } })).toBe(0);
  });

  it('refuse une nouvelle demande au-delà de N+1 sans créer de congé ni compteur', async () => {
    const fixture = await createFixture('TooFar', 'manager_admin');

    await expect(createFutureLeave(fixture, {
      date_debut: `${NEXT_YEAR + 1}-10-04`,
      date_fin: `${NEXT_YEAR + 1}-10-08`,
    })).rejects.toMatchObject({ status: 422 });
    expect(await Conge.count({ where: { utilisateur_id: fixture.employee.id } })).toBe(0);
    expect(await CompteurConges.count({ where: { utilisateur_id: fixture.employee.id } })).toBe(0);
  });

  it('respecte le choix explicite du salarié d’imputer une demande N+1 sur N', async () => {
    const fixture = await createFixture('ExplicitCurrentYear');
    await createCounter(fixture, CURRENT_YEAR, 5);

    const leave = await createFutureLeave(fixture, { annee_compteur: CURRENT_YEAR });
    const counter = await CompteurConges.findOne({
      where: {
        utilisateur_id: fixture.employee.id,
        conge_type_id: fixture.leaveType.id,
        annee: CURRENT_YEAR,
      },
    });

    expect(leave.statut).toBe('en_attente_manager');
    expect(leave.annee_compteur).toBe(CURRENT_YEAR);
    expect(Number(counter.jours_reserves)).toBe(5);
    expect(await CompteurConges.count({
      where: { utilisateur_id: fixture.employee.id, annee: NEXT_YEAR },
    })).toBe(0);
  });
});