'use strict';
/**
 * counterAuditLog.test.js — Fix #31
 *
 * Chaque mutation de compteur (upsert / delete) doit créer une entrée
 * dans AuditLog avec before/after et l'identité de l'admin.
 */

const request  = require('supertest');
const bcrypt   = require('bcrypt');
const app      = require('../src/index');
const {
  Entreprise, Utilisateur, CongeType, CompteurConges, AuditLog,
} = require('../src/models');
const { generateToken } = require('./helpers/auth');

let entreprise, employe, admin, congeType, tokenAdmin;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  entreprise = await Entreprise.create({
    nom: 'CounterAudit ' + Date.now(),
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  employe = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Emp', nom: 'Audit31',
    email: `emp.ca31.${Date.now()}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  admin = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Adm', nom: 'Audit31',
    email: `adm.ca31.${Date.now()}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });

  congeType = await CongeType.create({
    entreprise_id: entreprise.id,
    code: 'CP31', libelle: 'Congés payés 31',
    quota_annuel: 25, demi_journee_autorisee: true,
  });

  tokenAdmin = generateToken(admin);
});

afterAll(async () => {
  await AuditLog.destroy({ where: { entreprise_id: entreprise.id } });
  await CompteurConges.destroy({ where: { entreprise_id: entreprise.id } });
  await CongeType.destroy({ where: { entreprise_id: entreprise.id } });
  await Utilisateur.destroy({ where: { entreprise_id: entreprise.id } });
  await Entreprise.destroy({ where: { id: entreprise.id } });
});

describe('Fix #31 — Audit log sur les mutations de compteurs', () => {
  let compteurId;

  it('upsert (création) crée un AuditLog COUNTER_UPDATED avec before/after', async () => {
    const res = await request(app)
      .post(`/api/quotas/counters/${employe.id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({
        conge_type_id: congeType.id,
        annee: 2027,
        jours_acquis: 20,
        jours_pris: 2,
      });

    expect(res.status).toBe(200);
    compteurId = res.body?.item?.id;
    expect(compteurId).toBeDefined();

    // Laisser le temps à la promesse fire-and-forget de s'écrire
    await new Promise(r => setTimeout(r, 150));

    const log = await AuditLog.findOne({
      where: {
        action: 'COUNTER_UPDATED',
        entity: 'compteur_conges',
        entity_id: compteurId,
      },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.user_id).toBe(admin.id);
    expect(log.entreprise_id).toBe(entreprise.id);

    const meta = log.metadata;
    expect(meta.utilisateur_cible_id).toBe(employe.id);
    expect(meta.conge_type_id).toBe(congeType.id);
    expect(meta.annee).toBe(2027);
    // before : compteur venait d'être créé → solde initial (accrual mensuel ou 0)
    expect(typeof meta.before.jours_acquis).toBe('number');
    // after : la valeur demandée
    expect(meta.after.jours_acquis).toBe(20);
    expect(meta.after.jours_pris).toBe(2);
  });

  it('upsert (mise à jour) enregistre bien l\'ancienne et la nouvelle valeur', async () => {
    const res = await request(app)
      .post(`/api/quotas/counters/${employe.id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({
        conge_type_id: congeType.id,
        annee: 2027,
        jours_acquis: 25,
        jours_pris: 5,
      });

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 150));

    // Récupérer le dernier log (après le upsert de création)
    const logs = await AuditLog.findAll({
      where: { action: 'COUNTER_UPDATED', entity: 'compteur_conges', entity_id: compteurId },
      order: [['created_at', 'ASC']],
    });

    expect(logs.length).toBe(2);
    const second = logs[1];
    // L'ancienne valeur correspond à ce qu'on avait mis lors du premier upsert
    expect(second.metadata.before.jours_acquis).toBe(20);
    expect(second.metadata.before.jours_pris).toBe(2);
    expect(second.metadata.after.jours_acquis).toBe(25);
    expect(second.metadata.after.jours_pris).toBe(5);
  });

  it('delete crée un AuditLog COUNTER_DELETED avec le snapshot', async () => {
    expect(compteurId).toBeDefined();

    const res = await request(app)
      .delete(`/api/quotas/counters/${compteurId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 150));

    const log = await AuditLog.findOne({
      where: {
        action: 'COUNTER_DELETED',
        entity: 'compteur_conges',
        entity_id: compteurId,
      },
    });

    expect(log).not.toBeNull();
    expect(log.user_id).toBe(admin.id);
    const meta = log.metadata;
    expect(meta.utilisateur_cible_id).toBe(employe.id);
    expect(typeof meta.snapshot.jours_acquis).toBe('number');
    expect(meta.snapshot.jours_acquis).toBe(25);
  });
});
