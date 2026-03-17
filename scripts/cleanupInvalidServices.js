#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { sequelize, Utilisateur, Entreprise } = require('../src/models');

async function cleanupInvalidServices() {
  try {
    await sequelize.authenticate();
    console.log('✓ Connecté à la base de données\n');

    const enterprises = await Entreprise.findAll({ attributes: ['id', 'nom', 'politique_conges'] });
    console.log(`Analyse de ${enterprises.length} entreprises...\n`);

    let totalIssues = 0;
    let totalFixed = 0;

    for (const enterprise of enterprises) {
      const policy = enterprise.politique_conges || {};
      const validServices = Object.keys(policy.service_policies || {});

      // Trouver tous les utilisateurs de cette entreprise
      const users = await Utilisateur.findAll({
        where: { entreprise_id: enterprise.id },
        attributes: ['id', 'nom', 'prenom', 'email', 'service', 'role'],
      });

      const problematicUsers = users.filter(
        (user) => user.service && !validServices.includes(user.service)
      );

      if (problematicUsers.length > 0) {
        totalIssues += problematicUsers.length;
        console.log(`\n⚠️  Entreprise: ${enterprise.nom}`);
        console.log(`   Services valides: ${validServices.length > 0 ? validServices.join(', ') : 'AUCUN'}`);
        console.log(`   Utilisateurs avec service invalide: ${problematicUsers.length}`);

        for (const user of problematicUsers) {
          console.log(
            `   - ${user.prenom} ${user.nom} (${user.email}) -> service: "${user.service}" (INVALIDE)`
          );

          // Affecter le service à NULL s'il n'y a pas de service valide
          if (validServices.length === 0) {
            user.service = null;
            await user.save();
            totalFixed++;
            console.log(`     ✓ Service défini à NULL`);
          } else {
            // Si c'est un manager, garder NULL
            if (user.role === 'manager') {
              user.service = null;
              await user.save();
              totalFixed++;
              console.log(`     ✓ Manager: Service défini à NULL`);
            } else if (user.role === 'employe') {
              // Pour les employés, affecter au premier service valide disponible
              user.service = validServices[0];
              await user.save();
              totalFixed++;
              console.log(`     ✓ Employé réaffecté à: "${validServices[0]}"`);
            }
          }
        }
      }
    }

    console.log(`\n${totalFixed > 0 ? '✓' : '✓'} Résumé:`);
    console.log(`  - Utilisateurs problématiques identifiés: ${totalIssues}`);
    console.log(`  - Utilisateurs corrigés: ${totalFixed}`);
    if (totalIssues === 0) {
      console.log(`\n✓ Aucun problème détecté! Les services sont valides.`);
    } else {
      console.log(`\n✓ Nettoyage terminé. Vous pouvez maintenant supprimer les services vides.`);
    }

    await sequelize.close();
  } catch (err) {
    console.error('✗ Erreur:', err.message);
    process.exit(1);
  }
}

cleanupInvalidServices();
