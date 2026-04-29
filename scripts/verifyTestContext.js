require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { randomUUID } = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const {
  Entreprise,
  Utilisateur,
  CongeType,
  CompteurConges,
  Conge,
} = require('../src/models');

function firstWeekdayFromToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function addBusinessDays(baseDate, numberOfDays) {
  const d = new Date(baseDate);
  let added = 0;

  while (added < numberOfDays) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      added += 1;
    }
  }

  return d.toISOString().slice(0, 10);
}

function makeToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, entreprise_id: user.entreprise_id },
    process.env.JWT_SECRET,
    { expiresIn: '30m' }
  );
}

async function createIsolatedContext() {
  const suffix = randomUUID().slice(0, 8);
  const passwordHash = await bcrypt.hash('Test@1234', 10);

  const entreprise = await Entreprise.create({
    nom: `verify-main-${suffix}`,
    statut: 'active',
    politique_conges: {
      approval_workflow: 'manager_admin',
      overlap_policy: 'block',
      minimum_notice_days: 0,
      max_consecutive_days: 365,
      report_autorise: false,
      report_max_jours: 0,
      blocked_days: {
        exclude_weekends: true,
        exclude_holidays: true,
        weekdays: [],
        specific_dates: [],
      },
      service_policies: {},
      max_employees_on_leave: {
        global: 999,
        by_service: {},
      },
      notification_settings: {
        on_create: false,
        on_validate: false,
        on_reject: false,
        on_comment: false,
      },
    },
  });

  const outsiderEntreprise = await Entreprise.create({
    nom: `verify-outsider-${suffix}`,
    statut: 'active',
    politique_conges: {
      approval_workflow: 'manager_admin',
      overlap_policy: 'block',
      minimum_notice_days: 0,
      max_consecutive_days: 365,
      report_autorise: false,
      report_max_jours: 0,
      blocked_days: {
        exclude_weekends: true,
        exclude_holidays: true,
        weekdays: [],
        specific_dates: [],
      },
      service_policies: {},
      max_employees_on_leave: {
        global: 999,
        by_service: {},
      },
      notification_settings: {
        on_create: false,
        on_validate: false,
        on_reject: false,
        on_comment: false,
      },
    },
  });

  const admin = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Verify',
    nom: 'Admin',
    email: `verify.admin.${suffix}@example.com`,
    role: 'admin_entreprise',
    password_hash: passwordHash,
    statut: 'actif',
    service: 'ops',
  });

  const manager = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Verify',
    nom: 'Manager',
    email: `verify.manager.${suffix}@example.com`,
    role: 'manager',
    password_hash: passwordHash,
    statut: 'actif',
    service: 'ops',
  });

  const employe = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Verify',
    nom: 'Employe',
    email: `verify.employe.${suffix}@example.com`,
    role: 'employe',
    password_hash: passwordHash,
    statut: 'actif',
    service: 'ops',
  });

  const congeType = await CongeType.create({
    entreprise_id: entreprise.id,
    libelle: `CP Verify ${suffix}`,
    code: `CPV-${suffix.toUpperCase()}`,
    demi_journee_autorisee: true,
    quota_annuel: 30,
    actif: true,
  });

  const outsiderCongeType = await CongeType.create({
    entreprise_id: outsiderEntreprise.id,
    libelle: `CP Outsider ${suffix}`,
    code: `CPO-${suffix.toUpperCase()}`,
    demi_journee_autorisee: true,
    quota_annuel: 30,
    actif: true,
  });

  const currentYear = new Date().getFullYear();
  await CompteurConges.create({
    entreprise_id: entreprise.id,
    utilisateur_id: employe.id,
    conge_type_id: congeType.id,
    annee: currentYear,
    jours_acquis: 30,
    jours_reserves: 0,
    jours_pris: 0,
    jours_reportes: 0,
  });

  const base = firstWeekdayFromToday();

  return {
    suffix,
    entreprise,
    outsiderEntreprise,
    users: {
      admin,
      manager,
      employe,
    },
    congeTypes: {
      primary: congeType,
      outsider: outsiderCongeType,
    },
    tokens: {
      admin: makeToken(admin),
      manager: makeToken(manager),
      employe: makeToken(employe),
    },
    dates: {
      createAStart: addBusinessDays(base, 20),
      createAEnd: addBusinessDays(base, 21),
      overlapDate: addBusinessDays(base, 20),
      invalidHalfDayDate: addBusinessDays(base, 40),
      wrongTypeStart: addBusinessDays(base, 50),
      wrongTypeEnd: addBusinessDays(base, 51),
      approvalAStart: addBusinessDays(base, 60),
      approvalAEnd: addBusinessDays(base, 61),
      approvalBStart: addBusinessDays(base, 75),
      approvalBEnd: addBusinessDays(base, 75),
      approvalCStart: addBusinessDays(base, 90),
      approvalCEnd: addBusinessDays(base, 91),
    },
  };
}

async function cleanupIsolatedContext(context) {
  if (!context?.entreprise?.id || !context?.outsiderEntreprise?.id) {
    return;
  }

  const entrepriseIds = [context.entreprise.id, context.outsiderEntreprise.id];

  await Conge.destroy({ where: { entreprise_id: entrepriseIds }, force: true });
  await CompteurConges.destroy({ where: { entreprise_id: entrepriseIds }, force: true });
  await CongeType.destroy({ where: { entreprise_id: entrepriseIds }, force: true });
  await Utilisateur.destroy({ where: { entreprise_id: entrepriseIds }, force: true });
  await Entreprise.destroy({ where: { id: entrepriseIds }, force: true });
}

module.exports = {
  createIsolatedContext,
  cleanupIsolatedContext,
};
