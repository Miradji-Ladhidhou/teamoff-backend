'use strict';

const fs = require('fs');
const path = require('path');
const { QueryTypes } = require('sequelize');
const sequelize = require('../src/config/database');
const { verifyStartupSchema } = require('../src/services/startupSchemaService');

async function checkDeployedSchema(args = process.argv.slice(2)) {
  try {
    if (args.length || process.env.NODE_ENV !== 'production') {
      throw new Error('Contrôle de production uniquement, sans argument supplémentaire.');
    }
    const required = fs.readdirSync(path.join(__dirname, '../migrations'))
      .filter(name => name.endsWith('.js'));
    await sequelize.transaction({ readOnly: true }, async transaction => {
      await sequelize.query('SET TRANSACTION READ ONLY', { transaction });
      const applied = await sequelize.query('SELECT name FROM public."SequelizeMeta"', {
        type: QueryTypes.SELECT, transaction,
      });
      const names = new Set(applied.map(row => row.name));
      const missing = required.filter(name => !names.has(name));
      if (missing.length) {
        throw new Error(`Migrations manquantes : ${missing.join(', ')}. Application administrative requise avant déploiement.`);
      }
      await sequelize.query(`
        SELECT id, "key", entreprise_id, utilisateur_id, event, status, created_at, updated_at
        FROM public.notification_delivery LIMIT 0
      `, { type: QueryTypes.SELECT, transaction });
      const roles = await sequelize.query(`
        SELECT enumlabel FROM pg_enum
        WHERE enumtypid = 'public.enum_utilisateur_role'::regtype AND enumlabel = 'apprenti'
      `, { type: QueryTypes.SELECT, transaction });
      if (!roles.length) throw new Error('Schéma incompatible : rôle apprenti absent.');
      await verifyStartupSchema({
        query: (sql, options) => sequelize.query(sql, { ...options, transaction }),
      });
    });
    console.log('[deployment-schema] Schéma vérifié en lecture seule. Aucune migration exécutée.');
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  checkDeployedSchema().catch(error => {
    const { sanitizeMessage } = require('../src/utils/sanitizeLogData');
    console.error(`[deployment-schema] ${sanitizeMessage(error.message)}`);
    process.exitCode = 1;
  });
}

module.exports = { checkDeployedSchema };
