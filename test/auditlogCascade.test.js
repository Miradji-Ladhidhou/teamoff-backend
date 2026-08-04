'use strict';
/**
 * auditlogCascade.test.js
 *
 * Vérifie que les audit logs d'une entreprise survivent à sa suppression.
 *
 * AVANT fix  : onDelete CASCADE → les logs sont effacés → test FAIL
 * APRÈS fix  : onDelete SET NULL → les logs persistent avec entreprise_id=null → test PASS
 */

const { Entreprise, AuditLog, Utilisateur } = require('../src/models');

// IDs conservés pour cleanup en cas de panne mid-test
let entrepriseId, auditLogId, deletionLogId, superAdminId;

beforeAll(async () => {
  // Créer un super_admin sans entreprise (pour l'auteur de la suppression)
  const sa = await Utilisateur.create({
    prenom: 'Super', nom: 'Admin', email: `sa.cascade.test.${Date.now()}@test.local`,
    role: 'super_admin', password_hash: 'hash', statut: 'actif',
    entreprise_id: null,
  }).catch(() => null); // peut échouer si entreprise_id non nullable → on utilisera null
  superAdminId = sa?.id || null;
});

afterAll(async () => {
  // Nettoyage — les logs peuvent avoir entreprise_id=null après le test
  if (auditLogId)   await AuditLog.destroy({ where: { id: auditLogId }, force: true }).catch(() => {});
  if (deletionLogId) await AuditLog.destroy({ where: { id: deletionLogId }, force: true }).catch(() => {});
  if (entrepriseId) await Entreprise.destroy({ where: { id: entrepriseId }, force: true }).catch(() => {});
  if (superAdminId) await Utilisateur.destroy({ where: { id: superAdminId }, force: true }).catch(() => {});
});

describe('AuditLog — survie à la suppression d\'entreprise (fix CASCADE → SET NULL)', () => {
  it('les audit logs persistent avec entreprise_id=null après suppression de l\'entreprise', async () => {
    // 1. Créer une entreprise de test
    const entreprise = await Entreprise.create({
      nom: 'Cascade-Test-' + Date.now(),
      politique_conges: {},
      parametres: {},
    });
    entrepriseId = entreprise.id;

    // 2. Créer un log d'activité rattaché à cette entreprise
    const log = await AuditLog.create({
      action: 'USER_CREATED',
      entity: 'user',
      entity_id: entreprise.id,    // simule un log de création d'utilisateur
      entreprise_id: entreprise.id,
      ip_address: '127.0.0.1',
      metadata: { test: true },
    });
    auditLogId = log.id;

    // 3. Créer le log de suppression (écrit AVANT le destroy, comme le fait le controller fixé)
    const deletionLog = await AuditLog.create({
      action: 'ENTREPRISE_DELETED',
      entity: 'entreprise',
      entity_id: entreprise.id,
      entreprise_id: entreprise.id,
      user_id: superAdminId || null,
      metadata: { nom: entreprise.nom },
    });
    deletionLogId = deletionLog.id;

    // 4. Supprimer l'entreprise (déclenche SET NULL ou CASCADE selon la version)
    await entreprise.destroy();
    entrepriseId = null; // éviter double-destroy dans afterAll

    // 5. Vérifier que les logs survivent
    const survivingLog = await AuditLog.findByPk(auditLogId);
    expect(survivingLog).not.toBeNull();   // doit exister encore
    expect(survivingLog.action).toBe('USER_CREATED');
    expect(survivingLog.entity_id).toBe(log.entity_id);  // UUID préservé
    expect(survivingLog.entreprise_id).toBeNull();        // SET NULL appliqué

    const survivingDeletionLog = await AuditLog.findByPk(deletionLogId);
    expect(survivingDeletionLog).not.toBeNull();
    expect(survivingDeletionLog.action).toBe('ENTREPRISE_DELETED');
    expect(survivingDeletionLog.entity_id).toBe(entreprise.id);  // traçabilité préservée
    expect(survivingDeletionLog.entreprise_id).toBeNull();

    // Cleanup manuel (les logs sont orphelins, il faut les supprimer)
    await AuditLog.destroy({ where: { id: [auditLogId, deletionLogId] } });
    auditLogId = deletionLogId = null;
  });

  it('entreprise_id est nullable dans le modèle AuditLog (post-fix)', () => {
    // Vérifier que le modèle accepte allowNull: true
    const attr = AuditLog.getAttributes?.() || AuditLog.rawAttributes;
    expect(attr.entreprise_id.allowNull).toBe(true);
  });
});
