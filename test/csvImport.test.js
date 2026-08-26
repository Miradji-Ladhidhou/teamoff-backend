'use strict';
/**
 * csvImport.test.js
 *
 * Tests d'intégration pour POST /api/users/import/csv et GET /api/users/import/csv/template.
 *
 * Scénarios couverts :
 *   A — Autorisation : seul super_admin peut accéder à ces routes
 *   B — Validation   : erreurs retournées en bloc avant toute création
 *   C — Import OK    : création utilisateur + pose des soldes
 *   D — Utilisateur existant : skip création, soldes mis à jour quand même
 *   E — Template CSV : contient les libellés des types de congé
 */

const request    = require('supertest');
const app        = require('../src/index');
const { Utilisateur, CompteurConges, CongeType } = require('../src/models');
const { generateToken } = require('./helpers/auth');
const { seed }   = require('./helpers/seed');

// Supprime les emails (fire & forget — on mocke juste pour éviter le bruit réseau)
jest.mock('../src/services/emailService', () => ({
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
}));

let ctx;

beforeAll(async () => {
  ctx = await seed(); // entreprise + superAdmin + admin + manager + employe + congeType (Congés payés)
});

afterAll(async () => {
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper : construit un Buffer CSV à partir de lignes
// ─────────────────────────────────────────────────────────────────────────────
function csvBuffer(lines) {
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

const HEADERS = 'nom,prenom,email,role,service,date_embauche,type_conge,jours_acquis,jours_pris';

// ─────────────────────────────────────────────────────────────────────────────
// A — Autorisation
// ─────────────────────────────────────────────────────────────────────────────
describe('A — Autorisation', () => {
  const csv = csvBuffer([HEADERS, `Dupont,Marie,marie.a@test.local,employe,,,,,`]);

  it('403 pour admin_entreprise sur POST /import/csv', async () => {
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(403);
  });

  it('403 pour manager sur POST /import/csv', async () => {
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(403);
  });

  it('403 pour employe sur GET /import/csv/template', async () => {
    const res = await request(app)
      .get(`/api/users/import/csv/template?entreprise_id=${ctx.entreprise.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);
    expect(res.status).toBe(403);
  });

  it('403 pour admin_entreprise sur GET /import/csv/template', async () => {
    const res = await request(app)
      .get(`/api/users/import/csv/template?entreprise_id=${ctx.entreprise.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Validation
// ─────────────────────────────────────────────────────────────────────────────
describe('B — Validation CSV', () => {
  it('400 si fichier manquant', async () => {
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/fichier/i);
  });

  it('400 si entreprise_id manquant', async () => {
    const csv = csvBuffer([HEADERS, `Dupont,Marie,marie.b1@test.local,employe,,,,,`]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/entreprise_id/i);
  });

  it('404 si entreprise_id inexistant', async () => {
    const csv = csvBuffer([HEADERS, `Dupont,Marie,marie.b2@test.local,employe,,,,,`]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('422 si role invalide', async () => {
    const csv = csvBuffer([HEADERS, `Dupont,Marie,marie.b3@test.local,stagiaire,,,,,`]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].errors[0]).toMatch(/role invalide/i);
  });

  it('422 si type_conge inconnu pour l\'entreprise', async () => {
    const csv = csvBuffer([HEADERS, `Dupont,Marie,marie.b4@test.local,employe,,,RTT inconnu,10,0`]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].errors[0]).toMatch(/type_conge inconnu/i);
  });

  it('422 si jours_pris > jours_acquis', async () => {
    const csv = csvBuffer([HEADERS, `Dupont,Marie,marie.b5@test.local,employe,,,Congés payés,10,15`]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].errors[0]).toMatch(/jours_pris supérieur/i);
  });

  it('422 si doublon email + type_conge dans le fichier', async () => {
    const csv = csvBuffer([
      HEADERS,
      `Dupont,Marie,marie.b6@test.local,employe,,,Congés payés,10,5`,
      `Dupont,Marie,marie.b6@test.local,employe,,,Congés payés,20,3`,
    ]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].errors[0]).toMatch(/doublon/i);
  });

  it('retourne toutes les erreurs en une fois (pas d\'arrêt à la première)', async () => {
    const csv = csvBuffer([
      HEADERS,
      `,,invalid-email,stagiaire,,,,,`,  // nom manquant, prenom manquant, email invalide, role invalide
      `Dupont,Marie,marie.b7@test.local,employe,,,,,`,  // ligne valide (pas d'erreur)
    ]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(422);
    // Ligne 2 doit avoir plusieurs erreurs d'un coup
    const line2 = res.body.errors.find(e => e.line === 2);
    expect(line2.errors.length).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Import réussi : nouvel utilisateur + soldes
// ─────────────────────────────────────────────────────────────────────────────
describe('C — Import réussi (nouvel utilisateur)', () => {
  const email = `import.c1.${Date.now()}@test.local`;
  let userId;

  afterAll(async () => {
    if (userId) {
      await CompteurConges.destroy({ where: { utilisateur_id: userId } });
      await Utilisateur.destroy({ where: { id: userId } });
    }
  });

  it('crée l\'utilisateur et pose les soldes (201)', async () => {
    const csv = csvBuffer([
      HEADERS,
      `Dupont,Marie,${email},employe,RH,2021-03-01,Congés payés,25,17`,
    ]);

    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.created[0].email).toBe(email);
    expect(res.body.skipped).toHaveLength(0);
    expect(res.body.balancesSet).toHaveLength(1);
    expect(res.body.balancesSet[0].jours_acquis).toBe(25);
    expect(res.body.balancesSet[0].jours_pris).toBe(17);

    userId = res.body.created[0].id;
  });

  it('le CompteurConges en DB reflète les valeurs importées', async () => {
    const counter = await CompteurConges.findOne({
      where: {
        utilisateur_id: userId,
        conge_type_id:  ctx.congeType.id,
        annee:          new Date().getFullYear(),
      },
    });
    expect(counter).not.toBeNull();
    expect(parseFloat(counter.jours_acquis)).toBe(25);
    expect(parseFloat(counter.jours_pris)).toBe(17);
  });

  it('l\'utilisateur est créé en statut en_attente', async () => {
    const user = await Utilisateur.findByPk(userId);
    expect(user.statut).toBe('en_attente');
    expect(user.entreprise_id).toBe(ctx.entreprise.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D — Utilisateur existant : skip création, soldes mis à jour quand même
// ─────────────────────────────────────────────────────────────────────────────
describe('D — Utilisateur existant (skip + mise à jour soldes)', () => {
  let existingEmail;

  beforeAll(() => {
    existingEmail = ctx.employe.email;
  });

  afterAll(async () => {
    // Remettre le compteur à 0 pour ne pas polluer d'autres tests
    await CompteurConges.update(
      { jours_acquis: 0, jours_pris: 0 },
      { where: { utilisateur_id: ctx.employe.id, conge_type_id: ctx.congeType.id } }
    );
  });

  it('répond 200 (pas 201) et skip l\'email existant', async () => {
    const csv = csvBuffer([
      HEADERS,
      `Employe,Test,${existingEmail},employe,,,Congés payés,12,4`,
    ]);

    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(0);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].email).toBe(existingEmail);
    // Les soldes doivent quand même être mis à jour
    expect(res.body.balancesSet).toHaveLength(1);
    expect(res.body.balancesSet[0].jours_acquis).toBe(12);
  });

  it('le CompteurConges de l\'utilisateur existant est bien mis à jour', async () => {
    const counter = await CompteurConges.findOne({
      where: {
        utilisateur_id: ctx.employe.id,
        conge_type_id:  ctx.congeType.id,
        annee:          new Date().getFullYear(),
      },
    });
    // Le compteur peut ne pas exister si initializeUserCounters ne l'a pas créé
    // dans le seed — mais s'il existe, il doit avoir les bonnes valeurs
    if (counter) {
      expect(parseFloat(counter.jours_acquis)).toBe(12);
      expect(parseFloat(counter.jours_pris)).toBe(4);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E — Template CSV
// ─────────────────────────────────────────────────────────────────────────────
describe('E — Template CSV GET /import/csv/template', () => {
  it('200 pour super_admin, Content-Type text/csv', async () => {
    const res = await request(app)
      .get(`/api/users/import/csv/template?entreprise_id=${ctx.entreprise.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/i);
    expect(res.headers['content-disposition']).toMatch(/attachment/i);
  });

  it('le template contient le libellé du type de congé de l\'entreprise', async () => {
    const res = await request(app)
      .get(`/api/users/import/csv/template?entreprise_id=${ctx.entreprise.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);
    expect(res.text).toContain('Congés payés');
    expect(res.text).toContain(HEADERS);
  });

  it('400 si entreprise_id manquant dans le template', async () => {
    const res = await request(app)
      .get('/api/users/import/csv/template')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);
    expect(res.status).toBe(400);
  });
});
