require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { Utilisateur, Entreprise, sequelize } = require('../models');

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Connexion OK');

    // Vérifie si une entreprise existe, sinon la crée
    let entreprise = await Entreprise.findOne();
    if (!entreprise) {
      entreprise = await Entreprise.create({
        id: uuidv4(),
        nom: 'Entreprise Test',
        statut: 'active',
      });
      console.log('✅ Entreprise de test créée');
    }

    // ❗ mot de passe EN CLAIR
    const user = await Utilisateur.create({
      id: uuidv4(),
      entreprise_id: entreprise.id,
      nom: 'Test User',
      email: 'test@example.com',
      role: 'employe',
      password_hash: 'monmotdepasse123',
    });

    console.log('✅ Utilisateur créé');
    process.exit(0);
  } catch (err) {
    console.error('❌ Erreur :', err);
    process.exit(1);
  }
})();
