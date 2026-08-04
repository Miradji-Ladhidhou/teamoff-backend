'use strict';
/**
 * Ajoute totp_used_token et totp_used_at sur la table utilisateur pour
 * l'anti-replay TOTP (bilan #23).
 *
 * totp_used_token : dernier code TOTP consommé (6 chiffres)
 * totp_used_at    : horodatage de cette consommation
 *
 * La combinaison permet de rejeter tout code identique présenté dans les 90 s
 * suivant sa première utilisation (window:1 = ±1 step de 30 s = 90 s max).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const desc = await queryInterface.describeTable('utilisateur');

    if (!desc.totp_used_token) {
      await queryInterface.addColumn('utilisateur', 'totp_used_token', {
        type: Sequelize.STRING(6),
        allowNull: true,
        defaultValue: null,
      });
    }

    if (!desc.totp_used_at) {
      await queryInterface.addColumn('utilisateur', 'totp_used_at', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('utilisateur', 'totp_used_at');
    await queryInterface.removeColumn('utilisateur', 'totp_used_token');
  },
};
