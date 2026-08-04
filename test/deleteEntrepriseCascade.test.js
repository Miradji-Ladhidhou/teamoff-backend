'use strict';
/**
 * deleteEntrepriseCascade.test.js
 *
 * BILAN #20 — Suppression d'entreprise sans cascade ORM définie.
 *
 * Vérifie qu'après suppression d'une entreprise :
 *   • tous les enregistrements liés (utilisateurs, congés, types, compteurs,
 *     jours fériés, notifications, absences, leave_policy) sont supprimés
 *   • les audit_logs sont conservés avec entreprise_id = NULL (SET NULL)
 *   • les holiday_templates sont conservés avec source_entreprise_id = NULL (SET NULL)
 *     AVANT fix : le template était supprimé (CASCADE) — BUG
 *     APRÈS fix  : le template survit avec source_entreprise_id = NULL
 */

const {
  sequelize,
  Entreprise, Utilisateur, Conge, CongeType, CompteurConges,
  JoursFeries, Notification, Absence, LeavePolicy, AuditLog,
  HolidayTemplate,
} = require('../src/models');
const { QueryTypes } = require('sequelize');

const suffix = String(Date.now()).slice(-6);
let ent, user, congeType, conge, compteur, ferie, notif, absence, policy, auditLog, template;

beforeAll(async () => {
  ent = await Entreprise.create({
    nom: 'CascadeTest-' + suffix,
    politique_conges: { approval_workflow: 'admin_only' },
    parametres: {},
  });

  user = await Utilisateur.create({
    prenom: 'Test', nom: 'Cascade',
    email: `cascade.${suffix}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    entreprise_id: ent.id,
  });

  congeType = await CongeType.create({
    libelle: 'Type Cascade', code: 'TC_' + suffix,
    entreprise_id: ent.id,
  });

  conge = await Conge.create({
    utilisateur_id: user.id,
    entreprise_id: ent.id,
    conge_type_id: congeType.id,
    date_debut: '2025-07-01',
    date_fin: '2025-07-03',
    debut_demi_journee: 'matin',
    fin_demi_journee: 'apres_midi',
    statut: 'en_attente_manager',
    jours_calcules: 3,
  });

  compteur = await CompteurConges.create({
    entreprise_id: ent.id,
    utilisateur_id: user.id,
    conge_type_id: congeType.id,
    annee: 2025,
    jours_acquis: 20,
    jours_pris: 0,
    jours_reserves: 0,
  });

  ferie = await JoursFeries.create({
    entreprise_id: ent.id,
    date: '2025-07-14',
    libelle: 'Fête nationale',
    recurrent: true,
  });

  notif = await Notification.create({
    utilisateur_id: user.id,
    entreprise_id: ent.id,
    type: 'conge_soumis',
    message: 'test cascade',
    lu: false,
  });

  absence = await Absence.create({
    utilisateur_id: user.id,
    entreprise_id: ent.id,
    date_debut: '2025-08-01',
    date_fin: '2025-08-01',
    type_absence: 'maladie',
    statut: 'signalée',
  });

  policy = await LeavePolicy.create({
    entreprise_id: ent.id,
    policy_data: { overlap_policy: 'allow' },
  });

  // AuditLog direct (hors hook afterDestroy)
  auditLog = await AuditLog.create({
    entreprise_id: ent.id,
    user_id: user.id,
    action: 'test.cascade',
    entity: 'test',
    entity_id: ent.id,
    metadata: {},
  });

  // HolidayTemplate : source = l'entreprise à supprimer
  template = await HolidayTemplate.create({
    name: 'Template Cascade ' + suffix,
    country_code: 'FR',
    source_entreprise_id: ent.id,
    created_by: user.id,
  });
});

// Pas de afterAll : l'entreprise et ses enfants sont supprimés dans les tests eux-mêmes.

describe('deleteEntreprise — cascade et préservation', () => {
  it('suppression de l\'entreprise de test réussit', async () => {
    await expect(ent.destroy()).resolves.not.toThrow();
  });

  it('utilisateur est supprimé (CASCADE)', async () => {
    const found = await Utilisateur.findByPk(user.id);
    expect(found).toBeNull();
  });

  it('congé est supprimé (CASCADE)', async () => {
    const found = await Conge.findByPk(conge.id);
    expect(found).toBeNull();
  });

  it('type de congé est supprimé (CASCADE)', async () => {
    const found = await CongeType.findByPk(congeType.id);
    expect(found).toBeNull();
  });

  it('compteur est supprimé (CASCADE)', async () => {
    const found = await CompteurConges.findByPk(compteur.id);
    expect(found).toBeNull();
  });

  it('jour férié est supprimé (CASCADE)', async () => {
    const found = await JoursFeries.findByPk(ferie.id);
    expect(found).toBeNull();
  });

  it('notification est supprimée (CASCADE)', async () => {
    const found = await Notification.findByPk(notif.id);
    expect(found).toBeNull();
  });

  it('absence est supprimée (CASCADE)', async () => {
    const found = await Absence.findByPk(absence.id);
    expect(found).toBeNull();
  });

  it('leave_policy est supprimée (CASCADE)', async () => {
    const found = await LeavePolicy.findByPk(policy.id);
    expect(found).toBeNull();
  });

  it('audit_log est conservé avec entreprise_id = NULL (SET NULL)', async () => {
    const rows = await sequelize.query(
      'SELECT entreprise_id FROM audit_logs WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: auditLog.id } }
    );
    expect(rows.length).toBe(1);
    expect(rows[0].entreprise_id).toBeNull();
  });

  it('holiday_template est conservé avec source_entreprise_id = NULL (SET NULL — fix #20)', async () => {
    // AVANT fix : le template était CASCADE-supprimé → rows.length = 0 → FAIL
    // APRÈS fix  : SET NULL → le template existe avec source_entreprise_id = NULL → PASS
    const rows = await sequelize.query(
      'SELECT source_entreprise_id FROM holiday_templates WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: template.id } }
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_entreprise_id).toBeNull();
  });
});
