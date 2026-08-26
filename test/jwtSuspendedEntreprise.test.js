'use strict';
/**
 * jwtSuspendedEntreprise.test.js — Fix #35
 *
 * Deux invariants à vérifier :
 * A) Un token d'employé émis AVANT la suspension est rejeté APRÈS.
 * B) Un super_admin doit pouvoir agir même si son propre entreprise_id
 *    pointe vers une entreprise suspendue (sinon deadlock : il ne peut plus
 *    la ré-activer). AVANT fix : super_admin est bloqué lui aussi → bug.
 */

const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/index');
const { Entreprise, Utilisateur } = require('../src/models');
const { generateToken } = require('./helpers/auth');

const TS = Date.now();

let clientEntreprise, employe, tokenEmploye;
let platformEntreprise, superAdmin, tokenSuperAdmin;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  // Entreprise cliente dont on va suspendre le compte
  clientEntreprise = await Entreprise.create({
    nom: `ClientSusp35_${TS}`,
    politique_conges: {}, parametres: {}, statut: 'active',
  });

  employe = await Utilisateur.create({
    entreprise_id: clientEntreprise.id,
    prenom: 'Emp', nom: 'Susp35',
    email: `emp.susp35.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  // Entreprise de la plateforme (super_admin)
  platformEntreprise = await Entreprise.create({
    nom: `PlatformSusp35_${TS}`,
    politique_conges: {}, parametres: {}, statut: 'active',
  });

  superAdmin = await Utilisateur.create({
    entreprise_id: platformEntreprise.id,
    prenom: 'Super', nom: 'Susp35',
    email: `super.susp35.${TS}@test.internal`,
    role: 'super_admin', password_hash: hash, statut: 'actif',
  });

  // Tokens émis AVANT toute suspension
  tokenEmploye   = generateToken(employe);
  tokenSuperAdmin = generateToken(superAdmin);
});

afterAll(async () => {
  // S'assurer que les entreprises sont réactivées avant nettoyage
  await clientEntreprise.update({ statut: 'active' }).catch(() => {});
  await platformEntreprise.update({ statut: 'active' }).catch(() => {});
  await Utilisateur.destroy({ where: { id: [employe.id, superAdmin.id] } }).catch(() => {});
  await Entreprise.destroy({ where: { id: [clientEntreprise.id, platformEntreprise.id] } }).catch(() => {});
});

describe('Fix #35 — JWT invalidés à la suspension d\'entreprise', () => {

  describe('A) Employé — token rejeté après suspension', () => {
    it('token valide AVANT suspension → 200', async () => {
      const res = await request(app)
        .get(`/api/entreprises/${clientEntreprise.id}`)
        .set('Authorization', `Bearer ${tokenEmploye}`);

      // L'employé n'a pas accès à /entreprises → 403 rôle, pas 401/suspension
      // On utilise /api/me pour tester l'auth pure
      const res2 = await request(app)
        .get('/api/me')
        .set('Authorization', `Bearer ${tokenEmploye}`);

      expect(res2.status).toBe(200);
    });

    it('token MÊME JWT rejeté APRÈS suspension de l\'entreprise → 403 ENTREPRISE_SUSPENDUE', async () => {
      await clientEntreprise.update({ statut: 'suspendue' });

      const res = await request(app)
        .get('/api/me')
        .set('Authorization', `Bearer ${tokenEmploye}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ENTREPRISE_SUSPENDUE');
    });

    afterAll(async () => {
      await clientEntreprise.update({ statut: 'active' });
    });
  });

  describe('B) Super_admin — NE doit PAS être bloqué par la suspension de sa propre entreprise', () => {
    it('AVANT fix : super_admin bloqué si son entreprise est suspendue (deadlock)', async () => {
      // Suspendre l'entreprise du super_admin lui-même
      await platformEntreprise.update({ statut: 'suspendue' });

      const res = await request(app)
        .get('/api/me')
        .set('Authorization', `Bearer ${tokenSuperAdmin}`);

      // APRÈS fix : le super_admin passe → 200
      // AVANT fix : le super_admin est bloqué → 403 (deadlock)
      expect(res.status).toBe(200);
    });

    afterAll(async () => {
      await platformEntreprise.update({ statut: 'active' });
    });
  });
});
