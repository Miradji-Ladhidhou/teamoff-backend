require('dotenv').config();

const bcrypt = require('bcrypt');
const { sequelize, Entreprise, Utilisateur } = require('../src/models');

const run = async () => {
  try {
    const email = process.env.SUPER_ADMIN_EMAIL;
    const password = process.env.SUPER_ADMIN_PASSWORD;
    const nom = process.env.SUPER_ADMIN_NAME || 'Super Admin';

    if (!email || !password) {
      throw new Error('Variables d’environnement manquantes');
    }

    await sequelize.authenticate();
    console.log('✅ DB connected');

    let entreprise = await Entreprise.findOne({
      where: { nom: 'TeamOff System' }
    });

    if (!entreprise) {
      entreprise = await Entreprise.create({
        nom: 'TeamOff System'
      });
    }

    const existing = await Utilisateur.findOne({ where: { email } });

    if (existing) {
      console.log('⚠️ Super admin déjà existant');
      return process.exit(0);
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await Utilisateur.create({
      nom,
      email,
      password_hash: passwordHash,
      role: 'super_admin',
      statut: 'actif',
      entreprise_id: entreprise.id
    });

    console.log('🎉 Super admin créé');
    process.exit(0);

  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

run();