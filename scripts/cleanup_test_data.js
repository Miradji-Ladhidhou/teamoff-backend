require('dotenv').config({
  path: '/Users/utilisateur/Desktop/Projet en cours/SaaS_TeamOff/teamoff-backend/.env'
});
const { sequelize } = require('../src/models');

const TEST_ENTREPRISE_ID = 'e3dff5e3-21c4-459c-8a78-43bb60002c65';
const TEST_CONGE_IDS = [
  'e0bca491-5082-422d-8d58-571df71eee35',
  'da207225-6131-40c5-b913-08961527d275',
  '041ee6fb-f5aa-48df-a634-e1926be41c52',
  'd877aefd-6db0-4762-8974-5279dded35c1',
  'ebf07ea8-6d78-4104-a4d0-09f9427b1ff0',
  '5e65cd10-3f5c-43f2-869c-6cba01557050'
];

(async () => {
  await sequelize.authenticate();
  console.log('Connexion BDD OK');

  const t = await sequelize.transaction();
  try {
    // 1. Supprimer les conges test sur les utilisateurs reels
    const [r1] = await sequelize.query(
      'DELETE FROM conge WHERE id IN (:ids) RETURNING id',
      { replacements: { ids: TEST_CONGE_IDS }, transaction: t }
    );
    console.log('Conges test (utilisateurs reels) supprimes:', r1.length);

    // 2. Recuperer les utilisateurs de l entreprise test
    const [testUsers] = await sequelize.query(
      'SELECT id FROM utilisateur WHERE entreprise_id = :eid',
      { replacements: { eid: TEST_ENTREPRISE_ID }, transaction: t }
    );
    const testUserIds = testUsers.map(u => u.id);
    console.log('Utilisateurs test trouves:', testUserIds.length, testUserIds);

    if (testUserIds.length > 0) {
      const [rn] = await sequelize.query(
        'DELETE FROM notification WHERE utilisateur_id IN (:ids) RETURNING id',
        { replacements: { ids: testUserIds }, transaction: t }
      );
      console.log('Notifications test supprimees:', rn.length);

      const [rcc] = await sequelize.query(
        'DELETE FROM compteur_conges WHERE utilisateur_id IN (:ids) RETURNING id',
        { replacements: { ids: testUserIds }, transaction: t }
      );
      console.log('Compteurs test supprimes:', rcc.length);

      const [rc] = await sequelize.query(
        'DELETE FROM conge WHERE utilisateur_id IN (:ids) RETURNING id',
        { replacements: { ids: testUserIds }, transaction: t }
      );
      console.log('Conges test (ent. test) supprimes:', rc.length);

      const [ral] = await sequelize.query(
        'DELETE FROM audit_logs WHERE utilisateur_id IN (:ids) RETURNING id',
        { replacements: { ids: testUserIds }, transaction: t }
      );
      console.log('Audit logs test supprimes:', ral.length);

      const [ru] = await sequelize.query(
        'DELETE FROM utilisateur WHERE entreprise_id = :eid RETURNING id, email',
        { replacements: { eid: TEST_ENTREPRISE_ID }, transaction: t }
      );
      console.log('Utilisateurs test supprimes:', ru.map(u => u.email));
    }

    // 3. Supprimer conge_types, jours_feries, audit_logs de l entreprise test
    await sequelize.query(
      'DELETE FROM conge_type WHERE entreprise_id = :eid',
      { replacements: { eid: TEST_ENTREPRISE_ID }, transaction: t }
    );
    await sequelize.query(
      'DELETE FROM jours_feries WHERE entreprise_id = :eid',
      { replacements: { eid: TEST_ENTREPRISE_ID }, transaction: t }
    );
    await sequelize.query(
      'DELETE FROM audit_logs WHERE entreprise_id = :eid',
      { replacements: { eid: TEST_ENTREPRISE_ID }, transaction: t }
    );

    // 4. Supprimer l entreprise test elle-meme
    const [re] = await sequelize.query(
      'DELETE FROM entreprise WHERE id = :eid RETURNING nom',
      { replacements: { eid: TEST_ENTREPRISE_ID }, transaction: t }
    );
    console.log('Entreprise test supprimee:', re[0] ? re[0].nom : '(deja absente)');

    await t.commit();
    console.log('\nDONE - Base de donnees nettoyee avec succes');

    // Verification finale
    const [remaining] = await sequelize.query('SELECT id, email FROM utilisateur ORDER BY created_at');
    console.log('\nUtilisateurs restants:', remaining.map(u => u.email));
    const [remEnts] = await sequelize.query('SELECT id, nom FROM entreprise ORDER BY created_at');
    console.log('Entreprises restantes:', remEnts.map(e => e.nom));

  } catch (err) {
    await t.rollback();
    console.error('ROLLBACK - Erreur:', err.message);
    process.exit(1);
  }

  await sequelize.close();
})().catch(async e => {
  console.error('ERREUR:', e.message);
  try { await sequelize.close(); } catch {}
  process.exit(1);
});
