// services/quotasService.js
const { CompteurConges, CongeType, Utilisateur, Entreprise, sequelize } = require('../models');
const { getPolitiqueType } = require('./politiqueConges');

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeCounterPayload(payload = {}) {
  return {
    jours_acquis: toNumber(payload.jours_acquis, 0),
    jours_pris: Math.max(0, toNumber(payload.jours_pris, 0)),
    jours_reportes: Math.max(0, toNumber(payload.jours_reportes, 0)),
    jours_reserves: Math.max(0, toNumber(payload.jours_reserves, 0)),
  };
}

async function ensureCounter({ entrepriseId, utilisateurId, congeTypeId, annee, transaction = null }) {
  const congeType = await CongeType.findOne({
    where: { id: congeTypeId, entreprise_id: entrepriseId },
    transaction,
  });

  if (!congeType) {
    throw new Error('Type de congé introuvable pour cette entreprise');
  }

  let compteur = await CompteurConges.findOne({
    where: { entreprise_id: entrepriseId, utilisateur_id: utilisateurId, conge_type_id: congeTypeId, annee },
    transaction,
  });

  if (!compteur) {
    compteur = await CompteurConges.create({
      entreprise_id: entrepriseId,
      utilisateur_id: utilisateurId,
      conge_type_id: congeTypeId,
      annee,
      jours_acquis: congeType.quota_annuel ?? 0,
      jours_pris: 0,
      jours_reportes: 0,
      jours_reserves: 0,
    }, { transaction });
  }

  return compteur;
}

/**
 * Initialise les compteurs pour une année donnée
 */
async function initQuotaAnnuel(entrepriseId, annee) {
  return await sequelize.transaction(async (t) => {
    const utilisateurs = await Utilisateur.findAll({ where: { entreprise_id: entrepriseId }, transaction: t });
    const types = await CongeType.findAll({ where: { entreprise_id: entrepriseId }, transaction: t });
    const entreprise = await Entreprise.findByPk(entrepriseId, { transaction: t });

    for (const u of utilisateurs) {
      for (const type of types) {
        const politique = getPolitiqueType(entreprise, type.code);
        let compteur = await CompteurConges.findOne({
          where: { utilisateur_id: u.id, conge_type_id: type.id, annee },
          transaction: t
        });

        // Calcul du report si applicable
        let report = 0;
        if (compteur && politique.report) {
          const solde = parseFloat(compteur.jours_acquis) + parseFloat(compteur.jours_reportes) - parseFloat(compteur.jours_pris);
          report = solde > politique.max_report ? politique.max_report : Math.max(0, solde);
        }

        if (compteur) {
          compteur.jours_acquis = type.quota_annuel ?? 0;
          compteur.jours_pris = 0;
          compteur.jours_reportes = report;
          await compteur.save({ transaction: t });
        } else {
          await CompteurConges.create({
            entreprise_id: entrepriseId,
            utilisateur_id: u.id,
            conge_type_id: type.id,
            annee,
            jours_acquis: type.quota_annuel ?? 0,
            jours_pris: 0,
            jours_reportes: report
          }, { transaction: t });
        }
      }
    }
  });
}

/**
 * Ajoute acquisition mensuelle progressive
 * Exemple : quota 30 jours → 2.5 jours/mois
 */
async function ajouterAcquisitionMensuelle(entrepriseId, annee, mois) {
  const entreprise = await Entreprise.findByPk(entrepriseId, {
    attributes: ['id', 'politique_conges'],
  });

  const accrualByType = entreprise?.politique_conges?.accrual_by_type || {};
  const compteurs = await CompteurConges.findAll({ where: { entreprise_id: entrepriseId, annee } });
  for (const c of compteurs) {
    const type = await CongeType.findByPk(c.conge_type_id);
    const configuredMonthly = toNumber(accrualByType[type?.id], NaN);
    const acquisitionMensuelle = Number.isFinite(configuredMonthly)
      ? configuredMonthly
      : ((type?.quota_annuel ?? 0) / 12);
    c.jours_acquis = parseFloat(c.jours_acquis) + acquisitionMensuelle;
    await c.save();
  }
}

/**
 * Récupère le solde total d'un utilisateur pour un type de congé
 */
async function getSoldeUtilisateur(utilisateur_id, conge_type_id, annee) {
  const compteur = await CompteurConges.findOne({ where: { utilisateur_id, conge_type_id, annee } });
  return compteur ? compteur.getSoldeDisponible() : 0;
}

/**
 * Récupère tous les soldes d'un utilisateur pour une année
 */
async function getSoldesUtilisateur(utilisateur_id, annee) {
  const compteurs = await CompteurConges.findAll({
    where: { utilisateur_id, annee },
    include: [{ model: require('../models').CongeType, as: 'conge_type' }]
  });

  return compteurs.map(c => ({
    conge_type_id: c.conge_type_id,
    conge_type: c.conge_type.libelle,
    jours_acquis: c.jours_acquis,
    jours_pris: c.jours_pris,
    jours_reportes: c.jours_reportes,
    jours_reserves: c.jours_reserves,
    solde_disponible: c.getSoldeDisponible()
  }));
}

async function listCountersForUser(entrepriseId, utilisateurId, annee) {
  const compteurs = await CompteurConges.findAll({
    where: { entreprise_id: entrepriseId, utilisateur_id: utilisateurId, annee },
    include: [{ model: require('../models').CongeType, as: 'conge_type' }],
    order: [[{ model: require('../models').CongeType, as: 'conge_type' }, 'libelle', 'ASC']]
  });

  return compteurs.map((c) => ({
    id: c.id,
    utilisateur_id: c.utilisateur_id,
    entreprise_id: c.entreprise_id,
    annee: c.annee,
    conge_type_id: c.conge_type_id,
    conge_type: c.conge_type ? {
      id: c.conge_type.id,
      code: c.conge_type.code,
      libelle: c.conge_type.libelle,
    } : null,
    jours_acquis: toNumber(c.jours_acquis, 0),
    jours_pris: toNumber(c.jours_pris, 0),
    jours_reportes: toNumber(c.jours_reportes, 0),
    jours_reserves: toNumber(c.jours_reserves, 0),
    solde_disponible: toNumber(c.getSoldeDisponible(), 0),
  }));
}

async function createOrUpdateCounter({ entrepriseId, utilisateurId, congeTypeId, annee, values }) {
  return sequelize.transaction(async (t) => {
    const utilisateur = await Utilisateur.findOne({
      where: { id: utilisateurId, entreprise_id: entrepriseId },
      transaction: t,
    });

    if (!utilisateur) {
      throw new Error('Utilisateur introuvable dans cette entreprise');
    }

    const compteur = await ensureCounter({
      entrepriseId,
      utilisateurId,
      congeTypeId,
      annee,
      transaction: t,
    });

    const normalized = normalizeCounterPayload(values);
    await compteur.update(normalized, { transaction: t });

    return compteur;
  });
}

async function deleteCounter({ entrepriseId, counterId }) {
  return sequelize.transaction(async (t) => {
    const where = { id: counterId };
    if (entrepriseId) {
      where.entreprise_id = entrepriseId;
    }

    const compteur = await CompteurConges.findOne({
      where,
      transaction: t,
    });

    if (!compteur) {
      throw new Error('Compteur introuvable');
    }

    await compteur.destroy({ transaction: t });
  });
}

module.exports = {
  initQuotaAnnuel,
  ajouterAcquisitionMensuelle,
  getSoldeUtilisateur,
  getSoldesUtilisateur,
  listCountersForUser,
  createOrUpdateCounter,
  deleteCounter,
};