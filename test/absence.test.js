require('dotenv').config();
// Tests du circuit complet Absence (API + upload)
const request = require('supertest');
const app = require('../src/index');
const { sequelize, Absence, Utilisateur, Entreprise } = require('../src/models');
const path = require('path');

let tokenEmploye, tokenManager, employe, manager, entreprise;

beforeAll(async () => {
  // Créer une entreprise et deux utilisateurs (employé, manager)
  entreprise = await Entreprise.create({ nom: 'TestAbsence', politique_conges: {}, parametres: {} });
  employe = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Test',
    nom: 'Employe',
    email: 'employe.absence@example.com',
    role: 'employe',
    password_hash: 'hash',
    statut: 'actif',
  });
  manager = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Test',
    nom: 'Manager',
    email: 'manager.absence@example.com',
    role: 'manager',
    password_hash: 'hash',
    statut: 'actif',
  });
  // Générer des tokens JWT valides (à adapter selon ta logique)
  const jwt = require('jsonwebtoken');
  tokenEmploye = jwt.sign({ id: employe.id, role: 'employe', entreprise_id: entreprise.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  tokenManager = jwt.sign({ id: manager.id, role: 'manager', entreprise_id: entreprise.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
});

afterAll(async () => {
  await Absence.destroy({ where: { utilisateur_id: employe.id } });
  await Utilisateur.destroy({ where: { id: [employe.id, manager.id] } });
  await Entreprise.destroy({ where: { id: entreprise.id } });
  await sequelize.close();
});

describe('Absence API', () => {
  let absenceId;

  test('POST /api/absences - création absence maladie avec justificatif', async () => {
    const resUpload = await request(app)
      .post('/api/absences/upload')
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .attach('justificatif', path.join(__dirname, 'fixtures', 'justif.pdf'));
    expect(resUpload.statusCode).toBe(201);
    expect(resUpload.body.url).toMatch(/justificatifs/);
    const res = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({
        type_absence: 'maladie',
        date_debut: '2026-03-20',
        date_fin: '2026-03-21',
        justificatif: resUpload.body.url,
        commentaire: 'Test maladie',
      });
    expect(res.statusCode).toBe(201);
    expect(res.body.type_absence).toBe('maladie');
    absenceId = res.body.id;
  });

  test('GET /api/absences - employé ne voit que ses absences', async () => {
    const res = await request(app)
      .get('/api/absences')
      .set('Authorization', `Bearer ${tokenEmploye}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every(a => a.utilisateur_id === employe.id)).toBe(true);
  });

  test('PATCH /api/absences/:id - employé modifie son commentaire', async () => {
    const res = await request(app)
      .patch(`/api/absences/${absenceId}`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({ commentaire: 'Modifié' });
    expect(res.statusCode).toBe(200);
    expect(res.body.commentaire).toBe('Modifié');
  });

  test("GET /api/absences - manager voit toutes les absences de l'entreprise", async () => {
    const res = await request(app)
      .get('/api/absences')
      .set('Authorization', `Bearer ${tokenManager}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.some(a => a.utilisateur_id === employe.id)).toBe(true);
  });
});

// ===========================================================================
describe('RGPD Art. 9 — commentaire arrêt maladie', () => {
  let employe2, tokenEmploye2, absenceMaladieId;

  beforeAll(async () => {
    // Deuxième employé dans la même entreprise
    employe2 = await Utilisateur.create({
      entreprise_id: entreprise.id,
      prenom: 'Collègue',
      nom: 'Test',
      email: 'collegue.absence@example.com',
      role: 'employe',
      password_hash: 'hash',
      statut: 'actif',
    });
    const jwt = require('jsonwebtoken');
    tokenEmploye2 = jwt.sign(
      { id: employe2.id, role: 'employe', entreprise_id: entreprise.id },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Créer une absence maladie avec commentaire sensible pour employe (le premier)
    const res = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({
        type_absence: 'maladie',
        date_debut: '2026-09-01',
        date_fin: '2026-09-05',
        commentaire: 'Post-opératoire — données médicales confidentielles',
      });
    expect(res.statusCode).toBe(201);
    absenceMaladieId = res.body.id;
  });

  afterAll(async () => {
    await Utilisateur.destroy({ where: { id: employe2.id } });
  });

  test('un collègue (employe) ne voit pas le commentaire maladie d\'un autre employé', async () => {
    const res = await request(app)
      .get('/api/absences')
      .set('Authorization', `Bearer ${tokenEmploye2}`);

    expect(res.statusCode).toBe(200);
    const absenceDuCollègue = res.body.find(a => a.id === absenceMaladieId);
    expect(absenceDuCollègue).toBeDefined();
    // Le commentaire doit être masqué
    expect(absenceDuCollègue.commentaire).toBeNull();
  });

  test('l\'employé voit son propre commentaire maladie', async () => {
    const res = await request(app)
      .get('/api/absences')
      .set('Authorization', `Bearer ${tokenEmploye}`);

    expect(res.statusCode).toBe(200);
    const saPropreAbsence = res.body.find(a => a.id === absenceMaladieId);
    expect(saPropreAbsence).toBeDefined();
    // L'employé voit son propre commentaire
    expect(saPropreAbsence.commentaire).toBe('Post-opératoire — données médicales confidentielles');
  });

  test('un manager voit le commentaire maladie de tous les employés', async () => {
    const res = await request(app)
      .get('/api/absences')
      .set('Authorization', `Bearer ${tokenManager}`);

    expect(res.statusCode).toBe(200);
    const absenceDuCollègue = res.body.find(a => a.id === absenceMaladieId);
    expect(absenceDuCollègue).toBeDefined();
    // Le manager voit le commentaire complet
    expect(absenceDuCollègue.commentaire).toBe('Post-opératoire — données médicales confidentielles');
  });

  test('une absence exceptionnelle expose son commentaire à tous (non sensible)', async () => {
    const resCreate = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({
        type_absence: 'absence_exceptionnelle',
        date_debut: '2026-09-10',
        date_fin: '2026-09-10',
        commentaire: 'Déménagement',
      });
    expect(resCreate.statusCode).toBe(201);
    const exId = resCreate.body.id;

    const res = await request(app)
      .get('/api/absences')
      .set('Authorization', `Bearer ${tokenEmploye2}`);

    const absenceExc = res.body.find(a => a.id === exId);
    expect(absenceExc).toBeDefined();
    // Les absences non-maladie ne sont pas masquées
    expect(absenceExc.commentaire).toBe('Déménagement');

    await Absence.destroy({ where: { id: exId } });
  });
});
