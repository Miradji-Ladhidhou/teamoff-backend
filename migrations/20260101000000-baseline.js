'use strict';

/**
 * Baseline migration — records the schema that already exists in production.
 * All createTable calls use { ifNotExists: true }.
 * All indexes use raw SQL CREATE INDEX IF NOT EXISTS (Sequelize v6 addIndex
 * does not honour ifNotExists in PostgreSQL dialect).
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    // ------------------------------------------------------------------
    // 1. entreprise
    // ------------------------------------------------------------------
    await queryInterface.createTable('entreprise', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      nom: { type: Sequelize.STRING(255), allowNull: false },
      politique_conges: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      parametres: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      statut: {
        type: Sequelize.ENUM('active', 'inactive', 'suspendue'),
        allowNull: false,
        defaultValue: 'active',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    }, { ifNotExists: true });

    // ------------------------------------------------------------------
    // 2. utilisateur
    // ------------------------------------------------------------------
    await queryInterface.createTable('utilisateur', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      entreprise_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'entreprise', key: 'id' },
        onDelete: 'CASCADE',
      },
      prenom: { type: Sequelize.STRING(255), allowNull: true },
      nom: { type: Sequelize.STRING(255), allowNull: false },
      service: { type: Sequelize.STRING(255), allowNull: true, defaultValue: null },
      email: { type: Sequelize.STRING(255), allowNull: false },
      role: {
        type: Sequelize.ENUM('super_admin', 'admin_entreprise', 'manager', 'employe'),
        allowNull: false,
      },
      password_hash: { type: Sequelize.STRING(255), allowNull: false },
      statut: {
        type: Sequelize.ENUM('actif', 'inactif', 'en_attente'),
        allowNull: false,
        defaultValue: 'en_attente',
      },
      date_embauche: { type: Sequelize.DATEONLY, allowNull: true, defaultValue: null },
      failed_login_attempts: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      locked_until: { type: Sequelize.DATE, allowNull: true, defaultValue: null },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    }, { ifNotExists: true });

    await q(`CREATE INDEX IF NOT EXISTS "utilisateur_entreprise_id_idx"      ON "utilisateur" ("entreprise_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "utilisateur_entreprise_role_idx"     ON "utilisateur" ("entreprise_id", "role")`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "utilisateur_entreprise_email_unique" ON "utilisateur" ("entreprise_id", "email")`);

    // ------------------------------------------------------------------
    // 3. conge_type
    // ------------------------------------------------------------------
    await queryInterface.createTable('conge_type', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      entreprise_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'entreprise', key: 'id' },
        onDelete: 'CASCADE',
      },
      code: { type: Sequelize.STRING(20), allowNull: false },
      libelle: { type: Sequelize.STRING(255), allowNull: false },
      quota_annuel: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
      demi_journee_autorisee: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    }, { ifNotExists: true });

    await q(`CREATE INDEX IF NOT EXISTS "conge_type_entreprise_id_idx"       ON "conge_type" ("entreprise_id")`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "conge_type_entreprise_code_unique" ON "conge_type" ("entreprise_id", "code")`);

    // ------------------------------------------------------------------
    // 4. compteur_conges
    // ------------------------------------------------------------------
    await queryInterface.createTable('compteur_conges', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      entreprise_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'entreprise', key: 'id' },
        onDelete: 'CASCADE',
      },
      utilisateur_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'utilisateur', key: 'id' },
        onDelete: 'CASCADE',
      },
      conge_type_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'conge_type', key: 'id' },
        onDelete: 'CASCADE',
      },
      annee: { type: Sequelize.INTEGER, allowNull: false },
      jours_acquis: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 0,
      },
      jours_pris: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 0,
      },
      jours_reportes: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 0,
      },
      jours_reserves: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 0,
      },
      jours_annules: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 0,
      },
      dernier_credit_mensuel: {
        type: Sequelize.STRING(7),
        allowNull: true,
        defaultValue: null,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    }, { ifNotExists: true });

    await q(`CREATE INDEX IF NOT EXISTS "compteur_conges_entreprise_user_annee_idx" ON "compteur_conges" ("entreprise_id", "utilisateur_id", "annee")`);
    await q(`CREATE INDEX IF NOT EXISTS "compteur_conges_user_type_annee_idx"       ON "compteur_conges" ("utilisateur_id", "conge_type_id", "annee")`);
    await q(`CREATE INDEX IF NOT EXISTS "compteur_conges_entreprise_annee_idx"      ON "compteur_conges" ("entreprise_id", "annee")`);
    await q(`CREATE INDEX IF NOT EXISTS "compteur_conges_entreprise_type_idx"       ON "compteur_conges" ("entreprise_id", "conge_type_id")`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "compteur_conges_unique"             ON "compteur_conges" ("entreprise_id", "utilisateur_id", "conge_type_id", "annee")`);

    // ------------------------------------------------------------------
    // 5. conge
    // ------------------------------------------------------------------
    await queryInterface.createTable('conge', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      entreprise_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'entreprise', key: 'id' },
        onDelete: 'CASCADE',
      },
      utilisateur_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'utilisateur', key: 'id' },
        onDelete: 'CASCADE',
      },
      conge_type_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'conge_type', key: 'id' },
        onDelete: 'RESTRICT',
      },
      date_debut: { type: Sequelize.DATEONLY, allowNull: false },
      date_fin: { type: Sequelize.DATEONLY, allowNull: false },
      debut_demi_journee: {
        type: Sequelize.ENUM('matin', 'apres_midi'),
        allowNull: false,
        defaultValue: 'matin',
      },
      fin_demi_journee: {
        type: Sequelize.ENUM('matin', 'apres_midi'),
        allowNull: false,
        defaultValue: 'apres_midi',
      },
      statut: {
        type: Sequelize.ENUM(
          'en_attente_manager',
          'valide_manager',
          'refuse_manager',
          'valide_final',
          'refuse_final',
        ),
        allowNull: false,
        defaultValue: 'en_attente_manager',
      },
      commentaire_employe: { type: Sequelize.TEXT, allowNull: true },
      commentaire_manager: { type: Sequelize.TEXT, allowNull: true },
      commentaire_admin: { type: Sequelize.TEXT, allowNull: true },
      jours_calcules: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true,
        defaultValue: null,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    }, { ifNotExists: true });

    await q(`CREATE INDEX IF NOT EXISTS "conge_entreprise_utilisateur_idx" ON "conge" ("entreprise_id", "utilisateur_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "conge_entreprise_statut_idx"      ON "conge" ("entreprise_id", "statut")`);
    await q(`CREATE INDEX IF NOT EXISTS "conge_entreprise_type_idx"        ON "conge" ("entreprise_id", "conge_type_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "conge_overlap_idx"                ON "conge" ("entreprise_id", "utilisateur_id", "date_debut", "date_fin")`);

    // ------------------------------------------------------------------
    // 6. jours_feries
    // ------------------------------------------------------------------
    await queryInterface.createTable('jours_feries', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      entreprise_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'entreprise', key: 'id' },
        onDelete: 'CASCADE',
      },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      libelle: { type: Sequelize.STRING(255), allowNull: false },
      recurrent: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      est_travail: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    }, { ifNotExists: true });

    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "jours_feries_entreprise_date_unique" ON "jours_feries" ("entreprise_id", "date")`);

    // ------------------------------------------------------------------
    // 7. notification
    // ------------------------------------------------------------------
    await queryInterface.createTable('notification', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      entreprise_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'entreprise', key: 'id' },
        onDelete: 'CASCADE',
      },
      utilisateur_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'utilisateur', key: 'id' },
        onDelete: 'CASCADE',
      },
      type: { type: Sequelize.STRING(50), allowNull: true },
      message: { type: Sequelize.TEXT, allowNull: false },
      url: { type: Sequelize.STRING(500), allowNull: true },
      lu: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    }, { ifNotExists: true });

    await q(`CREATE INDEX IF NOT EXISTS "notification_utilisateur_id_idx"  ON "notification" ("utilisateur_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "notification_utilisateur_lu_idx"  ON "notification" ("utilisateur_id", "lu")`);
    await q(`CREATE INDEX IF NOT EXISTS "notification_entreprise_id_idx"   ON "notification" ("entreprise_id")`);

    // ------------------------------------------------------------------
    // 8. audit_logs
    // ------------------------------------------------------------------
    await queryInterface.createTable('audit_logs', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      action: { type: Sequelize.STRING, allowNull: false },
      entity: { type: Sequelize.STRING, allowNull: true },
      entity_id: { type: Sequelize.UUID, allowNull: true },
      user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'utilisateur', key: 'id' },
        onDelete: 'SET NULL',
      },
      entreprise_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'entreprise', key: 'id' },
        onDelete: 'CASCADE',
      },
      ip_address: { type: Sequelize.STRING, allowNull: true },
      user_agent: { type: Sequelize.STRING, allowNull: true },
      metadata: { type: Sequelize.JSON, allowNull: true },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    }, { ifNotExists: true });

    await q(`CREATE INDEX IF NOT EXISTS "audit_logs_entreprise_id_idx"       ON "audit_logs" ("entreprise_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "audit_logs_user_id_idx"             ON "audit_logs" ("user_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "audit_logs_entreprise_created_at_idx" ON "audit_logs" ("entreprise_id", "created_at")`);
    await q(`CREATE INDEX IF NOT EXISTS "audit_logs_entity_idx"              ON "audit_logs" ("entity", "entity_id")`);

    // ------------------------------------------------------------------
    // 9. holiday_templates
    // ------------------------------------------------------------------
    await queryInterface.createTable('holiday_templates', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      name: { type: Sequelize.STRING(150), allowNull: false },
      region: { type: Sequelize.STRING(120), allowNull: true },
      country_code: {
        type: Sequelize.STRING(2),
        allowNull: false,
        defaultValue: 'FR',
      },
      created_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'utilisateur', key: 'id' },
        onDelete: 'SET NULL',
      },
      source_entreprise_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'entreprise', key: 'id' },
        onDelete: 'CASCADE',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    }, { ifNotExists: true });

    await q(`CREATE INDEX IF NOT EXISTS "holiday_templates_source_entreprise_idx" ON "holiday_templates" ("source_entreprise_id")`);
    await q(`CREATE INDEX IF NOT EXISTS "holiday_templates_created_by_idx"        ON "holiday_templates" ("created_by")`);
    await q(`CREATE INDEX IF NOT EXISTS "holiday_templates_country_code_idx"      ON "holiday_templates" ("country_code")`);

    // ------------------------------------------------------------------
    // 10. holiday_template_items
    // ------------------------------------------------------------------
    await queryInterface.createTable('holiday_template_items', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      template_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'holiday_templates', key: 'id' },
        onDelete: 'CASCADE',
      },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      libelle: { type: Sequelize.STRING(255), allowNull: false },
      recurrent: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      est_travail: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    }, { ifNotExists: true });

    await q(`CREATE UNIQUE INDEX IF NOT EXISTS "holiday_template_items_template_date_unique" ON "holiday_template_items" ("template_id", "date")`);

    // ------------------------------------------------------------------
    // 11. system_settings
    // ------------------------------------------------------------------
    await queryInterface.createTable('system_settings', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      key: { type: Sequelize.STRING(100), allowNull: false, unique: true },
      data: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      updated_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'utilisateur', key: 'id' },
        onDelete: 'SET NULL',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    }, { ifNotExists: true });
  },

  async down(queryInterface) {
    // Intentionally non-reversible — restore from backup.
  },
};
