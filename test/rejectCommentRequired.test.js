'use strict';
/**
 * rejectCommentRequired.test.js — Fix #28
 *
 * Vérifie que l'API POST /api/conges/:id/reject exige un commentaire non vide.
 *
 * AVANT fix : refus sans commentaire → 200 (bug — seule l'UI imposait le champ)
 * APRÈS fix  : refus sans commentaire → 422
 */

const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/index');
const { Entreprise, Utilisateur, Conge, CongeType, CompteurConges } = require('../src/models');
const { generateToken } = require('./helpers/auth');

let ctx; // { entreprise, manager, employe, congeType, managerToken }

async function createPendingConge() {
  return Conge.create({
    entreprise_id:   ctx.entreprise.id,
    utilisateur_id:  ctx.employe.id,
    conge_type_id:   ctx.congeType.id,
    date_debut:      '2027-03-01',
    date_fin:        '2027-03-05',
    debut_demi_journee: 'matin',
    fin_demi_journee:   'apres_midi',
    statut: 'en_attente_manager',
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('Test1234!', 10);

  const entreprise = await Entreprise.create({
    nom: 'RejectComment Test ' + Date.now(),
    politique_conges: { approval_workflow: 'manager_admin' },
    parametres: {},
    statut: 'active',
  });

  const manager = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Mgr', nom: 'Reject28',
    email: `mgr.rej28.${Date.now()}@test.internal`,
    role: 'manager',
    password_hash: passwordHash,
    statut: 'actif',
  });

  const employe = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Emp', nom: 'Reject28',
    email: `emp.rej28.${Date.now()}@test.internal`,
    role: 'employe',
    password_hash: passwordHash,
    statut: 'actif',
  });

  const congeType = await CongeType.create({
    entreprise_id: entreprise.id,
    code: 'CP28',
    libelle: 'Congés payés #28',
    quota_annuel: 25,
    demi_journee_autorisee: true,
  });

  ctx = {
    entreprise,
    manager,
    employe,
    congeType,
    managerToken: generateToken(manager),
  };
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await CompteurConges.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await CongeType.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await Utilisateur.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await Entreprise.destroy({ where: { id: ctx.entreprise.id } });
});

// ---------------------------------------------------------------------------
describe('POST /api/conges/:id/reject — commentaire obligatoire', () => {
  it('APRÈS FIX : refus sans corps → 422 (commentaire manquant)', async () => {
    const conge = await createPendingConge();

    const res = await request(app)
      .post(`/api/conges/${conge.id}/reject`)
      .set('Authorization', `Bearer ${ctx.managerToken}`)
      .send({});

    expect(res.status).toBe(422);

    // Congé non modifié
    const fresh = await Conge.findByPk(conge.id);
    expect(fresh.statut).toBe('en_attente_manager');

    await conge.destroy();
  });

  it('APRÈS FIX : refus avec commentaire vide → 422', async () => {
    const conge = await createPendingConge();

    const res = await request(app)
      .post(`/api/conges/${conge.id}/reject`)
      .set('Authorization', `Bearer ${ctx.managerToken}`)
      .send({ commentaire: '' });

    expect(res.status).toBe(422);

    const fresh = await Conge.findByPk(conge.id);
    expect(fresh.statut).toBe('en_attente_manager');

    await conge.destroy();
  });

  it('APRÈS FIX : refus avec commentaire espace seul → 422', async () => {
    const conge = await createPendingConge();

    const res = await request(app)
      .post(`/api/conges/${conge.id}/reject`)
      .set('Authorization', `Bearer ${ctx.managerToken}`)
      .send({ commentaire: '   ' });

    expect(res.status).toBe(422);

    const fresh = await Conge.findByPk(conge.id);
    expect(fresh.statut).toBe('en_attente_manager');

    await conge.destroy();
  });

  it('refus avec commentaire valide → 200 et statut refuse_*', async () => {
    const conge = await createPendingConge();

    const res = await request(app)
      .post(`/api/conges/${conge.id}/reject`)
      .set('Authorization', `Bearer ${ctx.managerToken}`)
      .send({ commentaire: 'Motif : charge équipe insuffisante' });

    expect(res.status).toBe(200);
    expect(['refuse_manager', 'refuse_final']).toContain(res.body.statut);
  });

  it('refus sans authentification → 401', async () => {
    const conge = await createPendingConge();

    const res = await request(app)
      .post(`/api/conges/${conge.id}/reject`)
      .send({ commentaire: 'Test' });

    expect(res.status).toBe(401);
    await conge.destroy();
  });
});
