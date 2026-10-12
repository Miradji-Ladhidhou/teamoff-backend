'use strict';

jest.mock('../src/services/notificationService', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
  creerNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/emailService', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
  sendLeaveUpdatedSelfConfirm: jest.fn().mockResolvedValue(undefined),
  sendLeaveCancelledSelfConfirm: jest.fn().mockResolvedValue(undefined),
  sendLeaveCancelledByAdmin: jest.fn().mockResolvedValue(undefined),
  sendLeaveRejectedManagerInfo: jest.fn().mockResolvedValue(undefined),
  sendLowBalance: jest.fn().mockResolvedValue(undefined),
}));

const service = require('../src/services/congesService');
const notificationService = require('../src/services/notificationService');
const emailService = require('../src/services/emailService');
const { seed } = require('./helpers/seed');
const { Conge, CompteurConges, LeavePolicy } = require('../src/models');

const ROLES = ['employe', 'apprenti', 'manager', 'admin_entreprise', 'super_admin'];
const STATUSES = ['reserve', 'en_attente_manager', 'valide_manager', 'valide_final'];
let ctx;
let year = 2040;

beforeAll(async () => {
  ctx = await seed();
  await ctx.employe.update({ service: 'Finance' });
  await ctx.manager.update({ service: 'Finance' });
  await ctx.entreprise.update({ politique_conges: { approval_workflow: 'manager_admin' } });
  await LeavePolicy.create({
    entreprise_id: ctx.entreprise.id,
    allow_modify_validated: true,
    allow_cancel_validated: true,
    min_notice_days: 0,
  });
});

beforeEach(() => jest.clearAllMocks());

afterAll(async () => {
  if (!ctx) return;
  await LeavePolicy.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await ctx.cleanup();
});

function actor(role) {
  if (role === 'admin_entreprise') return ctx.admin;
  if (role === 'super_admin') return ctx.superAdmin;
  if (role === 'manager') return ctx.manager;
  return { ...ctx.employe.toJSON(), role };
}

async function leave(statut, workflow = 'manager_admin') {
  year += 1;
  const date = `${year}-09-02`;
  const days = await service.calcJoursConges(ctx.entreprise.id, date, `${year}-09-08`, 'matin', 'apres_midi');
  await CompteurConges.create({
    entreprise_id: ctx.entreprise.id,
    utilisateur_id: ctx.employe.id,
    conge_type_id: ctx.congeType.id,
    annee: year,
    jours_acquis: 25,
    jours_reserves: statut === 'valide_final' ? 0 : days,
    jours_pris: statut === 'valide_final' ? days : 0,
  });
  return Conge.create({
    entreprise_id: ctx.entreprise.id,
    utilisateur_id: ctx.employe.id,
    conge_type_id: ctx.congeType.id,
    date_debut: date,
    date_fin: `${year}-09-08`,
    jours_calcules: days,
    annee_compteur: year,
    statut,
    effective_approval_workflow: workflow,
  });
}

function employeeEmails(templateName) {
  return notificationService.sendEmail.mock.calls
    .map(([payload]) => payload)
    .filter(payload => payload.to === ctx.employe.email && payload.templateName === templateName);
}

describe.each(ROLES)('Confirmation des actions du role %s', role => {
  const modifiableStatuses = ['employe', 'apprenti'].includes(role)
    ? STATUSES.filter(statut => statut !== 'valide_manager')
    : STATUSES;

  it.each(modifiableStatuses)('modification %s : une confirmation au salarie', async statut => {
    const conge = await leave(statut);
    await service.updateConge(conge.id, { commentaire_employe: 'Modification' }, actor(role));

    if (['en_attente_manager', 'valide_manager'].includes(statut)) {
      expect(emailService.sendLeaveUpdatedSelfConfirm).toHaveBeenCalledTimes(1);
      expect(emailService.sendLeaveUpdatedSelfConfirm.mock.calls[0][0].id).toBe(ctx.employe.id);
    } else {
      const template = statut === 'reserve' ? 'leave-reservation-employee' : 'leave-updated-employee';
      expect(employeeEmails(template)).toHaveLength(1);
      expect(emailService.sendLeaveUpdatedSelfConfirm).not.toHaveBeenCalled();
    }
  });

  it.each(STATUSES)('annulation %s : une confirmation au salarie', async statut => {
    const conge = await leave(statut);
    await service.deleteConge(conge.id, actor(role), { commentaire: 'Annulation' });

    if (['employe', 'apprenti'].includes(role)) {
      expect(emailService.sendLeaveCancelledSelfConfirm).toHaveBeenCalledTimes(1);
      expect(emailService.sendLeaveCancelledSelfConfirm.mock.calls[0][0].id).toBe(ctx.employe.id);
    } else {
      expect(employeeEmails('leave-cancelled-employee')).toHaveLength(1);
      expect(emailService.sendLeaveCancelledSelfConfirm).not.toHaveBeenCalled();
    }
    expect(await Conge.findByPk(conge.id)).toBeNull();
  });
});

describe('Creation et decisions', () => {
  it.each(['employe', 'apprenti', 'manager'])('creation par %s : confirmation au demandeur', async role => {
    const user = actor(role);
    year += 1;
    await CompteurConges.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: user.id,
      conge_type_id: ctx.congeType.id,
      annee: year,
      jours_acquis: 25,
    });
    await service.createConge({
      conge_type_id: ctx.congeType.id,
      date_debut: `${year}-09-02`,
      date_fin: `${year}-09-08`,
      reqUser: user,
    });
    expect(notificationService.sendEmail.mock.calls.map(([payload]) => payload).filter(
      payload => payload.to === user.email && payload.templateName === 'leave-created-employee'
    )).toHaveLength(1);
  });

  it.each(['manager', 'admin_entreprise', 'super_admin'])('validation par %s : confirmation au salarie', async role => {
    const conge = await leave(role === 'manager' ? 'en_attente_manager' : 'valide_manager');
    await service.validerConge(conge.id, actor(role), 'Validation');
    expect(employeeEmails(role === 'manager' ? 'leave-manager-validated-employee' : 'leave-approved-employee')).toHaveLength(1);
  });

  it('validation definitive par manager : confirmation au salarie', async () => {
    const conge = await leave('en_attente_manager', 'manager_only');
    await service.validerConge(conge.id, ctx.manager, 'Validation');
    expect(employeeEmails('leave-approved-employee')).toHaveLength(1);
  });

  it.each(['manager', 'admin_entreprise', 'super_admin'])('refus par %s : confirmation au salarie', async role => {
    const conge = await leave('en_attente_manager');
    await service.rejeterConge(conge.id, actor(role), 'Refus');
    expect(employeeEmails('leave-rejected-employee')).toHaveLength(1);
  });
});

describe.each(['manager'])('Actions sur son propre conge (%s)', role => {
  it.each(['reserve', 'en_attente_manager', 'valide_final'])('modification %s : confirmation', async statut => {
    await ctx.employe.update({ role });
    try {
      const conge = await leave(statut);
      await service.updateConge(conge.id, { commentaire_employe: 'Modification personnelle' }, ctx.employe);
      if (statut === 'en_attente_manager') {
        expect(emailService.sendLeaveUpdatedSelfConfirm).toHaveBeenCalledTimes(1);
      } else {
        expect(employeeEmails(statut === 'reserve' ? 'leave-reservation-employee' : 'leave-updated-employee')).toHaveLength(1);
      }
    } finally {
      await ctx.employe.update({ role: 'employe' });
    }
  });

  it.each(STATUSES)('annulation %s : confirmation', async statut => {
    await ctx.employe.update({ role });
    try {
      const conge = await leave(statut);
      await service.deleteConge(conge.id, ctx.employe, { commentaire: 'Annulation personnelle' });
      if (role === 'manager') {
        expect(employeeEmails('leave-cancelled-employee')).toHaveLength(1);
      } else {
        expect(emailService.sendLeaveCancelledSelfConfirm).toHaveBeenCalledTimes(1);
      }
    } finally {
      await ctx.employe.update({ role: 'employe' });
    }
  });
});

describe('Aucune confirmation pour une action echouee', () => {
  it('modification refusee : aucun email', async () => {
    const conge = await leave('valide_manager');
    await expect(service.updateConge(conge.id, { commentaire_employe: 'Test' }, actor('employe'))).rejects.toThrow();
    expect(notificationService.sendEmail).not.toHaveBeenCalled();
    expect(emailService.sendLeaveUpdatedSelfConfirm).not.toHaveBeenCalled();
  });

  it('modification annulee en transaction : aucun email', async () => {
    const conge = await leave('valide_final');
    notificationService.creerNotification.mockRejectedValueOnce(new Error('Notification indisponible'));
    await expect(service.updateConge(conge.id, { commentaire_admin: 'Test' }, ctx.admin)).rejects.toThrow('Notification indisponible');
    expect(notificationService.sendEmail).not.toHaveBeenCalled();
    expect(emailService.sendLeaveUpdatedSelfConfirm).not.toHaveBeenCalled();
  });

  it.each(['employe', 'admin_entreprise'])('annulation annulee en transaction (%s) : aucun email', async role => {
    const conge = await leave('en_attente_manager');
    const destroySpy = jest.spyOn(Conge.prototype, 'destroy').mockRejectedValueOnce(new Error('Suppression indisponible'));
    try {
      await expect(service.deleteConge(conge.id, actor(role))).rejects.toThrow('Suppression indisponible');
      expect(notificationService.sendEmail).not.toHaveBeenCalled();
      expect(emailService.sendLeaveCancelledSelfConfirm).not.toHaveBeenCalled();
      expect(await Conge.findByPk(conge.id)).not.toBeNull();
    } finally {
      destroySpy.mockRestore();
    }
  });
});
