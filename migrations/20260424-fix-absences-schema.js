"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable('Absences');

    // 1. Renommer colonne `type` → `type_absence` si elle existe encore
    if (tableDesc.type && !tableDesc.type_absence) {
      await queryInterface.renameColumn('Absences', 'type', 'type_absence');
    }

    // 2. Convertir type_absence en ENUM si c'est encore un STRING
    if (tableDesc.type || tableDesc.type_absence) {
      await queryInterface.sequelize.query(
        `ALTER TABLE "Absences" ALTER COLUMN "type_absence" TYPE VARCHAR(255)`
      );
      await queryInterface.sequelize.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_absences_type_absence') THEN
            CREATE TYPE "enum_Absences_type_absence" AS ENUM('maladie', 'absence_exceptionnelle');
          END IF;
        END $$;
      `);
      await queryInterface.sequelize.query(`
        ALTER TABLE "Absences"
          ALTER COLUMN "type_absence" TYPE "enum_Absences_type_absence"
          USING "type_absence"::"enum_Absences_type_absence"
      `);
    }

    // 3. Ajouter colonne `justificatif` si absente
    if (!tableDesc.justificatif) {
      await queryInterface.addColumn('Absences', 'justificatif', {
        type: Sequelize.STRING(500),
        allowNull: true,
      });
    }

    // 4. Convertir statut en ENUM et corriger le default
    if (tableDesc.statut) {
      await queryInterface.sequelize.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_Absences_statut') THEN
            CREATE TYPE "enum_Absences_statut" AS ENUM('signalée', 'approuvée', 'rejetée');
          END IF;
        END $$;
      `);
      // Migrer les anciennes valeurs 'en_attente' → 'signalée'
      await queryInterface.sequelize.query(
        `UPDATE "Absences" SET statut = 'signalée' WHERE statut = 'en_attente'`
      );
      // DROP DEFAULT avant le cast (PostgreSQL ne peut pas caster un default automatiquement)
      await queryInterface.sequelize.query(
        `ALTER TABLE "Absences" ALTER COLUMN statut DROP DEFAULT`
      );
      await queryInterface.sequelize.query(`
        ALTER TABLE "Absences"
          ALTER COLUMN statut TYPE "enum_Absences_statut"
          USING statut::"enum_Absences_statut"
      `);
      await queryInterface.sequelize.query(
        `ALTER TABLE "Absences" ALTER COLUMN statut SET DEFAULT 'signalée'`
      );
    }

    // 5. Ajouter indexes manquants
    const indexes = await queryInterface.showIndex('Absences');
    const indexedFields = indexes.map(i => JSON.stringify(i.fields));

    if (!indexedFields.includes(JSON.stringify(['utilisateur_id']))) {
      await queryInterface.addIndex('Absences', ['utilisateur_id']);
    }
    if (!indexedFields.includes(JSON.stringify(['entreprise_id']))) {
      await queryInterface.addIndex('Absences', ['entreprise_id']);
    }
    if (!indexedFields.includes(JSON.stringify(['entreprise_id', 'statut']))) {
      await queryInterface.addIndex('Absences', ['entreprise_id', 'statut']);
    }
    if (!indexedFields.includes(JSON.stringify(['date_debut', 'date_fin']))) {
      await queryInterface.addIndex('Absences', ['date_debut', 'date_fin']);
    }
  },

  async down(queryInterface, Sequelize) {
    // Rollback partiel : on ne renomme pas type_absence → type (perte de données possible)
    await queryInterface.removeIndex('Absences', ['utilisateur_id']).catch(() => {});
    await queryInterface.removeIndex('Absences', ['entreprise_id']).catch(() => {});
    await queryInterface.removeIndex('Absences', ['entreprise_id', 'statut']).catch(() => {});
    await queryInterface.removeIndex('Absences', ['date_debut', 'date_fin']).catch(() => {});
    await queryInterface.removeColumn('Absences', 'justificatif').catch(() => {});
  },
};
