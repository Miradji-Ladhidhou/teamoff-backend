'use strict';
/**
 * lockTimeout.test.js — Fix #40
 *
 * Deux invariants :
 * A) Chaque connexion Sequelize dispose de lock_timeout configuré (via afterConnect).
 *    AVANT fix : SHOW lock_timeout = '0' (attente infinie).
 *    APRÈS fix  : SHOW lock_timeout ≠ '0' (valeur du hook).
 *
 * B) Une transaction qui attend un verrou déjà tenu est interrompue après le
 *    lock_timeout plutôt que de bloquer indéfiniment.
 *    On utilise deux connexions pg brutes pour contrôler précisément la concurrence
 *    et éviter un test qui dure 30 secondes.
 */

const { QueryTypes } = require('sequelize');
const { Client }     = require('pg');
const sequelize      = require('../src/config/database');
const { Entreprise, Utilisateur } = require('../src/models');
const bcrypt = require('bcrypt');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function parseLockTimeout(pgValue) {
  // Postgres retourne '30s', '500ms', '0' etc.
  if (!pgValue || pgValue === '0') return 0;
  if (pgValue.endsWith('ms')) return parseInt(pgValue, 10);
  if (pgValue.endsWith('s'))  return parseInt(pgValue, 10) * 1000;
  if (pgValue.endsWith('min')) return parseInt(pgValue, 10) * 60000;
  return parseInt(pgValue, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// A) Vérification de la configuration sur une connexion Sequelize
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #40 — lock_timeout configuré sur toutes les connexions', () => {

  it('SHOW lock_timeout ≠ 0 sur une connexion Sequelize (afterConnect hook)', async () => {
    // QueryTypes.SELECT retourne directement le tableau de lignes
    const rows = await sequelize.query('SHOW lock_timeout', { type: QueryTypes.SELECT });
    const row = rows[0];
    const value = String(row?.lock_timeout ?? Object.values(row || {})[0] ?? '0');
    const ms = parseLockTimeout(value);
    // AVANT fix : ms === 0 (aucune limite)
    // APRÈS fix  : ms > 0 (hook configuré)
    expect(ms).toBeGreaterThan(0);
  });

  it('idle_in_transaction_session_timeout est configuré et non nul', async () => {
    const rows = await sequelize.query('SHOW idle_in_transaction_session_timeout', { type: QueryTypes.SELECT });
    const row = rows[0];
    const value = String(row?.idle_in_transaction_session_timeout ?? Object.values(row || {})[0] ?? '0');
    const ms = parseLockTimeout(value);
    expect(ms).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) Test comportemental — lock_timeout interrompt l'attente bloquante
//    On utilise deux pg.Client bruts avec un lock_timeout très court (500ms)
//    pour que le test reste rapide.
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #40 — comportement : verrou bloqué → erreur rapide', () => {

  let ent, testUser;
  let client1, client2;

  beforeAll(async () => {
    const hash = await bcrypt.hash('Test1234!', 10);
    ent = await Entreprise.create({
      nom: `LockTimeout40_${Date.now()}`,
      politique_conges: {}, parametres: {}, statut: 'active',
    });
    testUser = await Utilisateur.create({
      entreprise_id: ent.id,
      prenom: 'Lock', nom: 'Test40',
      email: `lock.test40.${Date.now()}@test.internal`,
      role: 'employe', password_hash: hash, statut: 'actif',
    });
  });

  beforeEach(async () => {
    client1 = new Client({ connectionString: process.env.DATABASE_URL });
    client2 = new Client({ connectionString: process.env.DATABASE_URL });
    await client1.connect();
    await client2.connect();
  });

  afterEach(async () => {
    // Garantir le rollback même si le test échoue
    await client1.query('ROLLBACK').catch(() => {});
    await client2.query('ROLLBACK').catch(() => {});
    await client1.end().catch(() => {});
    await client2.end().catch(() => {});
  });

  afterAll(async () => {
    await Utilisateur.destroy({ where: { id: testUser.id } }).catch(() => {});
    await Entreprise.destroy({ where: { id: ent.id } }).catch(() => {});
  });

  it('client1 tient le verrou → client2 reçoit une erreur lock timeout au lieu de bloquer', async () => {
    // Client 1 : ouvre une transaction et verrouille la ligne
    await client1.query('BEGIN');
    await client1.query(
      'SELECT id FROM utilisateur WHERE id = $1 FOR UPDATE',
      [testUser.id]
    );

    // Client 2 : lock_timeout court (500ms) pour que le test reste rapide.
    // Ce timeout démontre le mécanisme ; en production le hook fixe 30 000ms.
    await client2.query("SET lock_timeout = 500");

    // Client 2 essaie de verrouiller la même ligne → doit échouer rapidement
    const t2Start = Date.now();
    let lockError = null;
    try {
      await client2.query(
        'SELECT id FROM utilisateur WHERE id = $1 FOR UPDATE',
        [testUser.id]
      );
    } catch (err) {
      lockError = err;
    }
    const elapsed = Date.now() - t2Start;

    // L'erreur doit être une erreur de lock timeout (code 55P03)
    expect(lockError).not.toBeNull();
    expect(lockError.code).toBe('55P03');        // PostgreSQL error code for lock_not_available
    expect(lockError.message).toMatch(/lock timeout/i);

    // L'attente doit être courte (< 3s, pas infinie)
    expect(elapsed).toBeLessThan(3000);

    // Libérer le verrou de client1
    await client1.query('ROLLBACK');
  });

  it('après libération du verrou, le verrou est disponible immédiatement', async () => {
    // Client 1 tient, puis libère
    await client1.query('BEGIN');
    await client1.query(
      'SELECT id FROM utilisateur WHERE id = $1 FOR UPDATE',
      [testUser.id]
    );
    await client1.query('ROLLBACK');

    // Client 2 peut maintenant acquérir le verrou sans timeout
    await client2.query('BEGIN');
    const res = await client2.query(
      'SELECT id FROM utilisateur WHERE id = $1 FOR UPDATE',
      [testUser.id]
    );
    await client2.query('ROLLBACK');

    expect(res.rows[0].id).toBe(testUser.id);
  });
});
