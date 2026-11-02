'use strict';

const { CompteurConges, sequelize } = require('../models');

async function getImportCounter(where, transaction) {
  if (!transaction) throw new Error('Transaction obligatoire pour le compteur d’import.');
  const candidate = CompteurConges.build(where);
  await candidate.validate();

  // A conflict waits for the concurrent writer; the following READ COMMITTED
  // statement sees its committed row and locks it before balance calculation.
  await sequelize.query(`
    INSERT INTO public.compteur_conges
      (id, entreprise_id, utilisateur_id, conge_type_id, annee,
       jours_acquis, jours_pris, jours_reserves, jours_reportes,
       jours_reportes_consommes, jours_annules, created_at, updated_at)
    VALUES ($id, $entrepriseId, $utilisateurId, $congeTypeId, $annee,
      0, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (entreprise_id, utilisateur_id, conge_type_id, annee)
    DO NOTHING
  `, {
    bind: {
      id: candidate.id,
      entrepriseId: where.entreprise_id,
      utilisateurId: where.utilisateur_id,
      congeTypeId: where.conge_type_id,
      annee: where.annee,
    },
    transaction,
  });

  const counter = await CompteurConges.findOne({
    where, transaction, lock: transaction.LOCK.UPDATE,
  });
  if (!counter) throw new Error('Compteur d’import introuvable après création concurrente.');
  return counter;
}

module.exports = { getImportCounter };
