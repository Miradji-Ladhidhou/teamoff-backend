'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const bcrypt = require('bcrypt');
const { sequelize, Entreprise, Utilisateur } = require('../src/models');

const COMPANY_NAME = 'TeamOff Local Test Accounts';
const TEST_PASSWORD = 'Test1234!';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const accounts = [
  { email: 'local.superadmin@teamoff.test', prenom: 'Local', nom: 'Super Admin', role: 'super_admin' },
  { email: 'local.admin@teamoff.test', prenom: 'Local', nom: 'Admin', role: 'admin_entreprise' },
  { email: 'local.manager@teamoff.test', prenom: 'Local', nom: 'Manager', role: 'manager' },
  { email: 'local.employe@teamoff.test', prenom: 'Local', nom: 'Employé', role: 'employe' },
];

async function main() {
  if (process.env.NODE_ENV === 'production' || !process.env.DATABASE_URL) {
    throw new Error('Refus: configuration absente ou environnement production.');
  }

  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (!LOCAL_HOSTS.has(databaseUrl.hostname)) {
    throw new Error('Refus: le seed est autorisé uniquement sur une base locale.');
  }

  await sequelize.authenticate();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

  await sequelize.transaction(async (transaction) => {
    const [company] = await Entreprise.findOrCreate({
      where: { nom: COMPANY_NAME },
      defaults: { nom: COMPANY_NAME, statut: 'active', politique_conges: {}, parametres: {} },
      transaction,
    });

    if (company.statut !== 'active') {
      await company.update({ statut: 'active' }, { transaction });
    }

    for (const account of accounts) {
      const existing = await Utilisateur.findOne({
        where: { email: account.email },
        transaction,
      });

      if (existing && existing.entreprise_id !== company.id) {
        throw new Error(`Refus: ${account.email} appartient à une autre entreprise.`);
      }

      const values = {
        ...account,
        entreprise_id: company.id,
        password_hash: passwordHash,
        statut: 'actif',
        service: 'Test local',
        failed_login_attempts: 0,
        locked_until: null,
      };

      if (existing) {
        await existing.update(values, { transaction });
      } else {
        await Utilisateur.create(values, { transaction });
      }
    }
  });

  console.log(`Comptes locaux prêts (${COMPANY_NAME}):`);
  for (const account of accounts) {
    console.log(`${account.role}\t${account.email}`);
  }
  console.log(`Mot de passe commun: ${TEST_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());