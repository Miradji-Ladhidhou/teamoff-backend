require('dotenv').config();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { Utilisateur, Entreprise, sequelize } = require('../models');

const EMAIL    = process.env.SUPER_ADMIN_EMAIL;
const PASSWORD = process.env.SUPER_ADMIN_PASSWORD;
const PRENOM   = process.env.SUPER_ADMIN_PRENOM;
const NOM      = process.env.SUPER_ADMIN_NAME;

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Connexion Supabase OK');

    let entreprise = await Entreprise.findOne();
    if (!entreprise) {
      entreprise = await Entreprise.create({
        id: uuidv4(),
        nom: 'TeamOff Admin',
        statut: 'active',
      });
      console.log('✅ Entreprise créée');
    } else {
      console.log('✅ Entreprise existante utilisée :', entreprise.nom);
    }

    const existing = await Utilisateur.findOne({ where: { email: EMAIL } });
    if (existing) {
      console.log('⚠️  Utilisateur déjà existant avec cet email');
      await sequelize.close();
      process.exit(0);
    }

    const password_hash = await bcrypt.hash(PASSWORD, 10);

    await Utilisateur.create({
      id: uuidv4(),
      entreprise_id: entreprise.id,
      prenom: PRENOM,
      nom: NOM,
      email: EMAIL,
      role: 'super_admin',
      statut: 'actif',
      password_hash,
    });

    console.log('✅ Super admin créé');
    console.log('   Email :', EMAIL);

    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Erreur :', err.message);
    await sequelize.close();
    process.exit(1);
  }
})();
