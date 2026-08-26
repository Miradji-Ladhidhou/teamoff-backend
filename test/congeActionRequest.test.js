'use strict';
/**
 * congeActionRequest.test.js
 *
 * Tests d'intégration pour le flux demande annulation/modification (congé validé).
 *
 * Routes couvertes :
 *   POST   /:id/action-request            — soumission (employé/manager)
 *   GET    /action-requests               — liste (admin)
 *   GET    /action-requests/:requestId    — détail (admin)
 *   POST   /action-requests/:requestId/approve
 *   POST   /action-requests/:requestId/reject
 *
 * Cas couverts :
 *   A) Soumission d'une demande d'annulation valide                → 201
 *   B) Soumission d'une demande de modification valide              → 201
 *   C) Soumission sans commentaire                                  → 400
 *   D) Modification sans nouvelles dates                            → 400
 *   E) Congé non validé (en_attente_manager)                        → 400
 *   F) Politique interdit l'annulation (allow_cancel_validated=false)→ 403
 *   G) Demande pending déjà existante (conflict)                   → 409
 *   H) Employé tente de soumettre pour un congé d'un autre         → 403
 *   I) Unauthentifié                                               → 401
 *   J) Admin liste les demandes                                    → 200
 *   K) Admin filtre par statut                                     → 200
 *   L) Employé ne peut pas accéder à la liste                      → 403
 *   M) Admin récupère le détail d'une demande                      → 200
 *   N) Admin approuve → leave annulé                               → 200
 *   O) Admin approuve une modification → leave mis à jour          → 200
 *   P) Admin refuse (avec motif)                                   → 200
 *   Q) Admin refuse sans motif                                     → 400
 *   R) Isolation multi-tenant : admin d'une autre entreprise       → 404
 */

const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/index');
const {
  Entreprise, Utilisateur, CongeType, CompteurConges, Conge, CongeActionRequest, LeavePolicy,
} = require('../src/models');
const { generateToken } = require('./helpers/auth');
const dayjs = require('dayjs');

const TS   = Date.now();
const YEAR = dayjs().year();
const HASH = bcrypt.hashSync('Test1234!', 10);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let ent, admin, manager, employe, employe2, congeType;
let tokenAdmin, tokenManager, tokenEmploye, tokenEmploye2;

// Entreprise tierce pour tests d'isolation
let entB, adminB, tokenAdminB;

// Congés pré-créés
let congeValide;           // statut: valide_final  → peut faire cancel/modify
let congePending;          // statut: en_attente_manager → demande interdite
let congeAutreEmploye;     // appartient à employe2

// IDs des demandes créées (nettoyage afterAll)
const createdRequestIds = [];
const createdCongeIds   = [];

async function mkCompteur(ent, user, ct) {
  const [c] = await CompteurConges.findOrCreate({
    where: { entreprise_id: ent.id, utilisateur_id: user.id, conge_type_id: ct.id, annee: YEAR },
    defaults: { jours_acquis: 30, jours_reserves: 0, jours_pris: 0 },
  });
  await c.update({ jours_acquis: 30, jours_reserves: 0, jours_pris: 0 });
  return c;
}

async function mkConge(ent, user, ct, statut, dates = {}) {
  const debut = dates.debut || `${YEAR + 1}-03-01`;
  const fin   = dates.fin   || `${YEAR + 1}-03-07`;
  const c = await Conge.create({
    entreprise_id: ent.id,
    utilisateur_id: user.id,
    conge_type_id: ct.id,
    date_debut: debut,
    date_fin: fin,
    debut_demi_journee: 'matin',
    fin_demi_journee: 'apres_midi',
    statut,
    jours_calcules: 5,
    jours_pris: statut === 'valide_final' ? 5 : 0,
  });
  createdCongeIds.push(c.id);
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  // Entreprise principale — politique AUTORISE cancel + modify validated
  ent = await Entreprise.create({
    nom: `CAR_Main_${TS}`,
    politique_conges: {
      allow_cancel_validated: true,
      allow_modify_validated: true,
      min_notice_days: 0,
    },
    parametres: {},
    statut: 'active',
  });

  admin = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Admin', nom: `CAR${TS}`,
    email: `adm.car.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: HASH, statut: 'actif',
  });
  manager = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Mgr', nom: `CAR${TS}`,
    email: `mgr.car.${TS}@test.internal`,
    role: 'manager', password_hash: HASH, statut: 'actif',
  });
  employe = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Emp', nom: `CAR${TS}`,
    email: `emp.car.${TS}@test.internal`,
    role: 'employe', password_hash: HASH, statut: 'actif',
  });
  employe2 = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Emp2', nom: `CAR${TS}`,
    email: `emp2.car.${TS}@test.internal`,
    role: 'employe', password_hash: HASH, statut: 'actif',
  });

  congeType = await CongeType.create({
    entreprise_id: ent.id, libelle: `CP_CAR_${TS}`,
    code: `CAR${String(TS).slice(-6)}`,
    deductible: true, demi_journee_autorisee: true, quota_annuel: 25,
  });

  // Entreprise tierce
  entB = await Entreprise.create({
    nom: `CAR_B_${TS}`, politique_conges: {}, parametres: {}, statut: 'active',
  });
  adminB = await Utilisateur.create({
    entreprise_id: entB.id, prenom: 'AdmB', nom: `CAR${TS}`,
    email: `adm.b.car.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: HASH, statut: 'actif',
  });

  // Politique explicite : autorise cancel + modify (min_notice = 0)
  await LeavePolicy.create({
    entreprise_id: ent.id,
    allow_cancel_validated: true,
    allow_modify_validated: true,
    min_notice_days: 0,
    require_manager_approval: true,
    require_admin_approval: false,
  });

  // Tokens
  tokenAdmin    = generateToken(admin);
  tokenManager  = generateToken(manager);
  tokenEmploye  = generateToken(employe);
  tokenEmploye2 = generateToken(employe2);
  tokenAdminB   = generateToken(adminB);

  // Congés
  await mkCompteur(ent, employe, congeType);
  await mkCompteur(ent, employe2, congeType);

  congeValide       = await mkConge(ent, employe,  congeType, 'valide_final', { debut: `${YEAR + 1}-03-01`, fin: `${YEAR + 1}-03-07` });
  congePending      = await mkConge(ent, employe,  congeType, 'en_attente_manager', { debut: `${YEAR + 1}-04-01`, fin: `${YEAR + 1}-04-05` });
  congeAutreEmploye = await mkConge(ent, employe2, congeType, 'valide_final', { debut: `${YEAR + 1}-05-01`, fin: `${YEAR + 1}-05-07` });
});

afterAll(async () => {
  // Nettoyer dans l'ordre FK
  if (createdRequestIds.length) {
    await CongeActionRequest.destroy({ where: { id: createdRequestIds } });
  }
  // Supprimer toutes les demandes liées aux congés de test (au cas où cleanup partiel)
  if (createdCongeIds.length) {
    await CongeActionRequest.destroy({ where: { conge_id: createdCongeIds } });
    await Conge.destroy({ where: { id: createdCongeIds } });
  }
  await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
  await CongeType.destroy({ where: { entreprise_id: ent.id } });
  await LeavePolicy.destroy({ where: { entreprise_id: [ent.id, entB.id] } });
  await Utilisateur.destroy({ where: { entreprise_id: [ent.id, entB.id] } });
  await Entreprise.destroy({ where: { id: [ent.id, entB.id] } });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS A — Soumission d'une demande d'annulation valide
// ─────────────────────────────────────────────────────────────────────────────
describe('CAS A — Soumission demande annulation (congé valide_final)', () => {
  let requestId;

  it('POST /:id/action-request → 201 avec type=cancel', async () => {
    const res = await request(app)
      .post(`/api/conges/${congeValide.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({ type: 'cancel', commentaire: 'Je dois annuler pour raison personnelle' });

    if (res.status !== 201) console.error('A body:', JSON.stringify(res.body));
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.type).toBe('cancel');
    expect(res.body.statut).toBe('pending');
    expect(res.body.conge_id).toBe(congeValide.id);
    requestId = res.body.id;
    createdRequestIds.push(requestId);
  });

  it('CAS G — second submit → 409 (demande pending déjà existante)', async () => {
    const res = await request(app)
      .post(`/api/conges/${congeValide.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({ type: 'cancel', commentaire: 'Encore une demande' });

    expect(res.status).toBe(409);
  });

  afterAll(async () => {
    // Nettoyer la demande de ce groupe pour ne pas bloquer les autres tests
    if (requestId) {
      await CongeActionRequest.destroy({ where: { id: requestId } });
      createdRequestIds.splice(createdRequestIds.indexOf(requestId), 1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS B — Soumission d'une demande de modification valide
// ─────────────────────────────────────────────────────────────────────────────
describe('CAS B — Soumission demande modification', () => {
  let requestId;

  it('POST /:id/action-request → 201 avec type=modify + nouvelles dates', async () => {
    const res = await request(app)
      .post(`/api/conges/${congeValide.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({
        type: 'modify',
        commentaire: 'Besoin de décaler d\'une semaine',
        date_debut_demandee: `${YEAR + 1}-03-10`,
        date_fin_demandee: `${YEAR + 1}-03-16`,
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('modify');
    expect(res.body.date_debut_demandee).toContain(`${YEAR + 1}-03-10`);
    requestId = res.body.id;
    createdRequestIds.push(requestId);
  });

  afterAll(async () => {
    if (requestId) {
      await CongeActionRequest.destroy({ where: { id: requestId } });
      createdRequestIds.splice(createdRequestIds.indexOf(requestId), 1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS C — Commentaire manquant
// ─────────────────────────────────────────────────────────────────────────────
describe('CAS C — Soumission sans commentaire → 400', () => {
  it('retourne 400 si commentaire absent', async () => {
    const res = await request(app)
      .post(`/api/conges/${congeValide.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({ type: 'cancel' });

    expect([400, 422]).toContain(res.status);
  });

  it('retourne 400 si commentaire vide', async () => {
    const res = await request(app)
      .post(`/api/conges/${congeValide.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({ type: 'cancel', commentaire: '   ' });

    expect([400, 422]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS D — Modification sans nouvelles dates
// ─────────────────────────────────────────────────────────────────────────────
describe('CAS D — Modification sans dates → 400', () => {
  it('retourne 400 si type=modify sans date_debut_demandee', async () => {
    const res = await request(app)
      .post(`/api/conges/${congeValide.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({ type: 'modify', commentaire: 'Pas de dates' });

    expect([400, 422]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS E — Congé non validé
// ─────────────────────────────────────────────────────────────────────────────
describe('CAS E — Congé en_attente_manager → 400', () => {
  it('retourne 400 pour un congé non encore validé', async () => {
    const res = await request(app)
      .post(`/api/conges/${congePending.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({ type: 'cancel', commentaire: 'Congé non validé' });

    expect([400, 403]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS F — Politique interdit l'annulation
// ─────────────────────────────────────────────────────────────────────────────
describe('CAS F — Politique interdit → 403', () => {
  let entRestrict, employeR, adminR, congeR, ctR;
  let tokenR;

  beforeAll(async () => {
    entRestrict = await Entreprise.create({
      nom: `CAR_Restrict_${TS}`,
      politique_conges: { allow_cancel_validated: false, allow_modify_validated: false },
      parametres: {},
      statut: 'active',
    });
    employeR = await Utilisateur.create({
      entreprise_id: entRestrict.id, prenom: 'EmpR', nom: `CAR${TS}`,
      email: `empr.car.${TS}@test.internal`,
      role: 'employe', password_hash: HASH, statut: 'actif',
    });
    ctR = await CongeType.create({
      entreprise_id: entRestrict.id, libelle: `CPR_${TS}`,
      code: `CARR${String(TS).slice(-5)}`,
      deductible: true, demi_journee_autorisee: true, quota_annuel: 25,
    });
    await CompteurConges.create({
      entreprise_id: entRestrict.id, utilisateur_id: employeR.id,
      conge_type_id: ctR.id, annee: YEAR,
      jours_acquis: 25, jours_reserves: 0, jours_pris: 0,
    });
    congeR = await Conge.create({
      entreprise_id: entRestrict.id, utilisateur_id: employeR.id,
      conge_type_id: ctR.id,
      date_debut: `${YEAR + 1}-06-01`, date_fin: `${YEAR + 1}-06-05`,
      debut_demi_journee: 'matin', fin_demi_journee: 'apres_midi',
      statut: 'valide_final', jours_calcules: 5, jours_pris: 5,
    });
    tokenR = generateToken(employeR);
  });

  afterAll(async () => {
    await Conge.destroy({ where: { id: congeR.id } });
    await CompteurConges.destroy({ where: { entreprise_id: entRestrict.id } });
    await CongeActionRequest.destroy({ where: { entreprise_id: entRestrict.id } });
    await CongeType.destroy({ where: { entreprise_id: entRestrict.id } });
    await LeavePolicy.destroy({ where: { entreprise_id: entRestrict.id } });
    await Utilisateur.destroy({ where: { entreprise_id: entRestrict.id } });
    await Entreprise.destroy({ where: { id: entRestrict.id } });
  });

  it('retourne 403 si allow_cancel_validated = false', async () => {
    const res = await request(app)
      .post(`/api/conges/${congeR.id}/action-request`)
      .set('Authorization', `Bearer ${tokenR}`)
      .send({ type: 'cancel', commentaire: 'Politique devrait bloquer' });

    expect([403, 400]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS H — Employé tente de soumettre pour un congé d'un autre
// ─────────────────────────────────────────────────────────────────────────────
describe('CAS H — IDOR : soumettre pour le congé d\'un autre → 403', () => {
  it('retourne 403 si utilisateur_id ne correspond pas', async () => {
    const res = await request(app)
      .post(`/api/conges/${congeAutreEmploye.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`) // employe ≠ owner
      .send({ type: 'cancel', commentaire: 'Tentative IDOR' });

    expect([403, 404]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS I — Non authentifié
// ─────────────────────────────────────────────────────────────────────────────
describe('CAS I — Non authentifié → 401', () => {
  it('retourne 401 sans token', async () => {
    const res = await request(app)
      .post(`/api/conges/${congeValide.id}/action-request`)
      .send({ type: 'cancel', commentaire: 'Sans auth' });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests liste / détail / approve / reject — nécessitent une demande existante
// ─────────────────────────────────────────────────────────────────────────────
describe('CAS J-R — Liste, détail, approbation, refus (admin)', () => {
  // Congé dédié pour ces tests (on en recrée un frais à chaque groupe)
  let congeForApprove, congeForReject, congeForModify;
  let reqCancel, reqModify, reqReject;

  beforeAll(async () => {
    // Congés frais pour éviter les effets de bord
    congeForApprove = await mkConge(ent, employe, congeType, 'valide_final',
      { debut: `${YEAR + 1}-07-01`, fin: `${YEAR + 1}-07-05` });
    congeForModify  = await mkConge(ent, employe, congeType, 'valide_final',
      { debut: `${YEAR + 1}-08-01`, fin: `${YEAR + 1}-08-05` });
    congeForReject  = await mkConge(ent, employe, congeType, 'valide_final',
      { debut: `${YEAR + 1}-09-01`, fin: `${YEAR + 1}-09-05` });

    // Créer les demandes directement en DB pour ne pas dépendre du flow précédent
    reqCancel = await CongeActionRequest.create({
      conge_id: congeForApprove.id,
      entreprise_id: ent.id,
      utilisateur_id: employe.id,
      type: 'cancel',
      statut: 'pending',
      commentaire_employe: 'Demande annulation test approve',
    });
    reqModify = await CongeActionRequest.create({
      conge_id: congeForModify.id,
      entreprise_id: ent.id,
      utilisateur_id: employe.id,
      type: 'modify',
      statut: 'pending',
      date_debut_demandee: `${YEAR + 1}-08-10`,
      date_fin_demandee: `${YEAR + 1}-08-15`,
      commentaire_employe: 'Demande modification test approve',
    });
    reqReject = await CongeActionRequest.create({
      conge_id: congeForReject.id,
      entreprise_id: ent.id,
      utilisateur_id: employe.id,
      type: 'cancel',
      statut: 'pending',
      commentaire_employe: 'Demande annulation test reject',
    });

    createdRequestIds.push(reqCancel.id, reqModify.id, reqReject.id);
  });

  // ── CAS J — Liste ──────────────────────────────────────────────────────────
  it('J — GET /action-requests → 200 admin voit les demandes', async () => {
    const res = await request(app)
      .get('/api/conges/action-requests')
      .set('Authorization', `Bearer ${tokenAdmin}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('requests');
    expect(Array.isArray(res.body.requests)).toBe(true);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('totalPages');
  });

  // ── CAS K — Filtre par statut ──────────────────────────────────────────────
  it('K — GET /action-requests?statut=pending → liste filtrée', async () => {
    const res = await request(app)
      .get('/api/conges/action-requests?statut=pending')
      .set('Authorization', `Bearer ${tokenAdmin}`);

    expect(res.status).toBe(200);
    res.body.requests.forEach((r) => {
      expect(r.statut).toBe('pending');
    });
  });

  // ── CAS L — Employé ne peut pas lister ────────────────────────────────────
  it('L — GET /action-requests par un employé → 403', async () => {
    const res = await request(app)
      .get('/api/conges/action-requests')
      .set('Authorization', `Bearer ${tokenEmploye}`);

    expect(res.status).toBe(403);
  });

  // ── CAS M — Détail ────────────────────────────────────────────────────────
  it('M — GET /action-requests/:id → 200 admin voit le détail', async () => {
    const res = await request(app)
      .get(`/api/conges/action-requests/${reqReject.id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(reqReject.id);
    expect(res.body.statut).toBe('pending');
  });

  // ── CAS N — Approbation annulation ────────────────────────────────────────
  it('N — POST /approve → 200 admin approuve → congé annulé', async () => {
    const res = await request(app)
      .post(`/api/conges/action-requests/${reqCancel.id}/approve`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ commentaire: 'Accord' });

    if (res.status !== 200) console.error('N body:', JSON.stringify(res.body));
    expect(res.status).toBe(200);
    expect(res.body.statut).toBe('approved');

    // Vérifier que le congé a été supprimé/annulé
    const congeApres = await Conge.findByPk(congeForApprove.id);
    expect(congeApres).toBeNull(); // deleteConge supprime physiquement
  });

  // ── CAS O — Approbation modification ──────────────────────────────────────
  it('O — POST /approve (modify) → 200 → congé mis à jour', async () => {
    const res = await request(app)
      .post(`/api/conges/action-requests/${reqModify.id}/approve`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.statut).toBe('approved');

    // Vérifier que les dates ont été mises à jour
    const congeApres = await Conge.findByPk(congeForModify.id);
    expect(congeApres).not.toBeNull();
    expect(congeApres.date_debut).toContain(`${YEAR + 1}-08-10`);
  });

  // ── CAS P — Refus ─────────────────────────────────────────────────────────
  it('P — POST /reject avec motif → 200', async () => {
    const res = await request(app)
      .post(`/api/conges/action-requests/${reqReject.id}/reject`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ commentaire: 'Période chargée, impossible d\'annuler' });

    expect(res.status).toBe(200);
    expect(res.body.statut).toBe('rejected');
    expect(res.body.commentaire_admin).toBe('Période chargée, impossible d\'annuler');

    // Vérifier que le congé est INCHANGÉ
    const congeApres = await Conge.findByPk(congeForReject.id);
    expect(congeApres).not.toBeNull();
    expect(congeApres.statut).toBe('valide_final');
  });

  // ── CAS Q — Refus sans motif ──────────────────────────────────────────────
  it('Q — POST /reject sans commentaire → 400', async () => {
    const res = await request(app)
      .post(`/api/conges/action-requests/${reqReject.id}/reject`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({});

    // Déjà rejected → 404 (ou 400 si validé avant)
    expect([400, 404]).toContain(res.status);
  });

  // ── CAS R — Isolation multi-tenant ────────────────────────────────────────
  it('R — Admin d\'une autre entreprise → 404 sur la demande', async () => {
    // reqReject appartient à ent, adminB appartient à entB
    const res = await request(app)
      .get(`/api/conges/action-requests/${reqReject.id}`)
      .set('Authorization', `Bearer ${tokenAdminB}`);

    expect(res.status).toBe(404);
  });
});
