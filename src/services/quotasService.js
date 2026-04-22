// services/quotasService.js
const { CompteurConges, CongeType, Utilisateur, Entreprise, sequelize } = require('../models');
const { getLeaveRules } = require('./politiqueConges');

const isQuotasDebug = process.env.QUOTAS_DEBUG === 'true';

function quotasLog(...args) {
  if (isQuotasDebug) {
    console.log(...args);
  }
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getCurrentYear() {
  return new Date().getFullYear();
}

function getMonthKey(annee, mois) {
  return `${Number(annee)}-${String(Number(mois)).padStart(2, '0')}`;
}

function getCurrentMonthKey() {
  const now = new Date();
  return getMonthKey(now.getFullYear(), now.getMonth() + 1);
}

function normalizeCounterPayload(payload = {}) {
  const sourceAcquired = payload.conges_acquis ?? payload.solde_conges ?? payload.jours_acquis;

  return {
    jours_acquis: toNumber(sourceAcquired, 0),
    jours_pris: Math.max(0, toNumber(payload.jours_pris, 0)),
    jours_reportes: Math.max(0, toNumber(payload.jours_reportes, 0)),
    jours_reserves: Math.max(0, toNumber(payload.jours_reserves, 0)),
  };
}

function computeProratedAcquiredDays({ annualQuota }) {
  const quota = toNumber(annualQuota, 0);

  // Compatibilité historique: on conserve la fonction mais sans aucune proratisation.
  return Number(Math.max(0, quota).toFixed(2));
}

function getMonthlyAccrualForType({ leaveRules, congeType }) {
  const configured = toNumber(leaveRules?.accrual_by_type?.[congeType.id], NaN);
  if (Number.isFinite(configured) && configured >= 0) {
    return Number(configured.toFixed(2));
  }

  const fallback = toNumber(congeType?.quota_annuel, 0) / 12;
  return Number(Math.max(0, fallback).toFixed(2));
}

async function getEntrepriseLeaveRules(entrepriseId, transaction = null) {
  const entreprise = await Entreprise.findByPk(entrepriseId, {
    attributes: ['id', 'politique_conges'],
    transaction,
  });

  if (!entreprise) {
    throw new Error('Entreprise introuvable');
  }

  return getLeaveRules(entreprise);
}

async function ensureCounter({
  entrepriseId,
  utilisateurId,
  congeTypeId,
  annee,
  transaction = null,
  leaveRules = null,
  congeType = null,
  initialBalance = null,
  initialCreditMonthKey,
}) {
  const targetYear = Number(annee);
  if (!Number.isFinite(targetYear) || targetYear < 2000 || targetYear > 2100) {
    throw new Error('Année invalide (2000-2100)');
  }

  let typeRecord = congeType;
  if (!typeRecord) {
    typeRecord = await CongeType.findOne({
      where: { id: congeTypeId, entreprise_id: entrepriseId },
      transaction,
    });
  }

  if (!typeRecord) {
    throw new Error('Type de congé introuvable pour cette entreprise');
  }

  let rules = leaveRules;
  if (!rules) {
    rules = await getEntrepriseLeaveRules(entrepriseId, transaction);
  }

  let compteur = await CompteurConges.findOne({
    where: { entreprise_id: entrepriseId, utilisateur_id: utilisateurId, conge_type_id: congeTypeId, annee: targetYear },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });

  if (!compteur) {
    const defaultInitialBalance = targetYear === getCurrentYear()
      ? getMonthlyAccrualForType({ leaveRules: rules, congeType: typeRecord })
      : 0;

    const normalizedInitialBalance = Number(
      Math.max(0, toNumber(initialBalance, defaultInitialBalance)).toFixed(2)
    );

    const defaultInitialMonthKey = targetYear === getCurrentYear() && normalizedInitialBalance > 0
      ? getCurrentMonthKey()
      : null;

    const creditMonthKey = typeof initialCreditMonthKey === 'undefined'
      ? defaultInitialMonthKey
      : initialCreditMonthKey;

    compteur = await CompteurConges.create({
      entreprise_id: entrepriseId,
      utilisateur_id: utilisateurId,
      conge_type_id: congeTypeId,
      annee: targetYear,
      jours_acquis: normalizedInitialBalance,
      jours_pris: 0,
      jours_reportes: 0,
      jours_reserves: 0,
      jours_annules: 0,
      dernier_credit_mensuel: creditMonthKey,
    }, { transaction });
  }

  return compteur;
}

async function initializeUserCounters({ entrepriseId, utilisateurId, annee = getCurrentYear(), transaction = null }) {
  const [leaveRules, congeTypes] = await Promise.all([
    getEntrepriseLeaveRules(entrepriseId, transaction),
    CongeType.findAll({ where: { entreprise_id: entrepriseId }, transaction }),
  ]);

  if (!Array.isArray(congeTypes) || congeTypes.length === 0) {
    return { created_or_existing: 0 };
  }

  for (const type of congeTypes) {
    await ensureCounter({
      entrepriseId,
      utilisateurId,
      congeTypeId: type.id,
      annee,
      transaction,
      leaveRules,
      congeType: type,
    });
  }

  return { created_or_existing: congeTypes.length };
}

/**
 * Initialise les compteurs pour une année donnée (sans recalcul des soldes existants)
 * Si le report annuel est activé, reporte les jours non pris de l'année précédente.
 */
async function initQuotaAnnuel(entrepriseId, annee) {
  return await sequelize.transaction(async (t) => {
    const [utilisateurs, congeTypes, leaveRules] = await Promise.all([
      Utilisateur.findAll({ where: { entreprise_id: entrepriseId }, attributes: ['id'], transaction: t }),
      CongeType.findAll({ where: { entreprise_id: entrepriseId }, transaction: t }),
      getEntrepriseLeaveRules(entrepriseId),
    ]);

    for (const utilisateur of utilisateurs) {
      await initializeUserCounters({
        entrepriseId,
        utilisateurId: utilisateur.id,
        annee,
        transaction: t,
      });

      // Report annuel : si activé, reporter les jours de N-1 vers N
      if (leaveRules.report_autorise && leaveRules.report_max_jours > 0) {
        const prevYear = Number(annee) - 1;

        for (const type of congeTypes) {
          const prevCounter = await CompteurConges.findOne({
            where: { entreprise_id: entrepriseId, utilisateur_id: utilisateur.id, conge_type_id: type.id, annee: prevYear },
            transaction: t,
          });
          if (!prevCounter) continue;

          const prevSolde = toNumber(prevCounter.jours_acquis, 0) - toNumber(prevCounter.jours_reserves, 0);
          if (prevSolde <= 0) continue;

          const carry = Number(Math.min(prevSolde, leaveRules.report_max_jours).toFixed(2));
          if (carry <= 0) continue;

          const newCounter = await CompteurConges.findOne({
            where: { entreprise_id: entrepriseId, utilisateur_id: utilisateur.id, conge_type_id: type.id, annee: Number(annee) },
            transaction: t,
            lock: t.LOCK.UPDATE,
          });
          if (!newCounter) continue;

          // Idempotent : ne pas re-appliquer le report si déjà effectué
          if (toNumber(newCounter.jours_reportes, 0) > 0) continue;

          newCounter.jours_acquis = Number((toNumber(newCounter.jours_acquis, 0) + carry).toFixed(2));
          newCounter.jours_reportes = carry;
          await newCounter.save({ transaction: t });

          quotasLog(`[report-annuel] ${utilisateur.id} / ${type.libelle}: ${carry}j reportes de ${prevYear} vers ${annee}`);
        }
      }
    }
  });
}

/**
 * Ajoute un crédit mensuel sans recalcul global.
 * Idempotent via le champ dernier_credit_mensuel (pas de double incrément).
 * Options:
 * - apply=false -> simulation uniquement
 */
async function ajouterAcquisitionMensuelle(entrepriseId, annee, mois, options = {}) {
  const targetYear = Number(annee || getCurrentYear());
  const targetMonth = Number(mois || (new Date().getMonth() + 1));
  const apply = options?.apply !== false;
  const previewLimit = Math.max(1, Number(options?.previewLimit || 30));

  if (!Number.isFinite(targetYear) || targetYear < 2000 || targetYear > 2100) {
    throw new Error('Année invalide (2000-2100)');
  }

  if (!Number.isFinite(targetMonth) || targetMonth < 1 || targetMonth > 12) {
    throw new Error('Mois invalide (1-12)');
  }

  const targetMonthKey = getMonthKey(targetYear, targetMonth);

  return sequelize.transaction(async (t) => {
    const [leaveRules, utilisateurs, congeTypes, existingCounters] = await Promise.all([
      getEntrepriseLeaveRules(entrepriseId, t),
      Utilisateur.findAll({ where: { entreprise_id: entrepriseId }, attributes: ['id', 'prenom', 'nom'], transaction: t }),
      CongeType.findAll({ where: { entreprise_id: entrepriseId }, transaction: t }),
      CompteurConges.findAll({
        where: { entreprise_id: entrepriseId, annee: targetYear },
        transaction: t,
        lock: t.LOCK.UPDATE,
      }),
    ]);

    const countersByKey = new Map(
      existingCounters.map((c) => [`${c.utilisateur_id}::${c.conge_type_id}`, c])
    );

    const preview = [];
    let countersTotal = 0;
    let applied = 0;
    let skipped = 0;
    let toApply = 0;
    let totalAdded = 0;

    for (const utilisateur of utilisateurs) {
      for (const type of congeTypes) {
        countersTotal += 1;

        const key = `${utilisateur.id}::${type.id}`;
        let compteur = countersByKey.get(key) || null;
        const lastCreditMonth = compteur?.dernier_credit_mensuel || null;

        const alreadyCredited = lastCreditMonth === targetMonthKey;
        const hasFutureCredit = Boolean(lastCreditMonth) && lastCreditMonth > targetMonthKey;

        if (alreadyCredited || hasFutureCredit) {
          skipped += 1;
          continue;
        }

        const monthlyCredit = getMonthlyAccrualForType({ leaveRules, congeType: type });

        if (!compteur && apply) {
          compteur = await ensureCounter({
            entrepriseId,
            utilisateurId: utilisateur.id,
            congeTypeId: type.id,
            annee: targetYear,
            transaction: t,
            leaveRules,
            congeType: type,
            initialBalance: 0,
            initialCreditMonthKey: null,
          });
          countersByKey.set(key, compteur);
        }

        const currentAcquired = toNumber(compteur?.jours_acquis, 0);
        const nextAcquired = Number((currentAcquired + monthlyCredit).toFixed(2));

        if (preview.length < previewLimit) {
          preview.push({
            counter_id: compteur?.id || null,
            utilisateur_id: utilisateur.id,
            utilisateur_nom: `${utilisateur.prenom || ''} ${utilisateur.nom || ''}`.trim() || utilisateur.id,
            conge_type_id: type.id,
            conge_type_libelle: type.libelle,
            last_credit_month: lastCreditMonth,
            current_acquired: currentAcquired,
            monthly_credit: monthlyCredit,
            next_acquired: nextAcquired,
          });
        }

        if (apply) {
          compteur.jours_acquis = nextAcquired;
          compteur.dernier_credit_mensuel = targetMonthKey;
          await compteur.save({ transaction: t });
          applied += 1;
        } else {
          toApply += 1;
        }

        totalAdded = Number((totalAdded + monthlyCredit).toFixed(2));
      }
    }

    return {
      entreprise_id: entrepriseId,
      annee: targetYear,
      mois: targetMonth,
      month_key: targetMonthKey,
      apply,
      counters_total: countersTotal,
      to_apply: toApply,
      applied,
      skipped,
      total_added: totalAdded,
      preview,
    };
  });
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
    conges_acquis: c.jours_acquis,
    solde_conges: c.jours_acquis,
    jours_pris: c.jours_pris,
    jours_reportes: c.jours_reportes,
    jours_reserves: c.jours_reserves,
    jours_annules: c.jours_annules,
    dernier_credit_mensuel: c.dernier_credit_mensuel,
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
    jours_acquis_annee: Math.max(0, toNumber(c.jours_acquis, 0) - toNumber(c.jours_reportes, 0)),
    conges_acquis: toNumber(c.jours_acquis, 0),
    solde_conges: toNumber(c.jours_acquis, 0),
    jours_pris: toNumber(c.jours_pris, 0),
    jours_reportes: toNumber(c.jours_reportes, 0),
    jours_reserves: toNumber(c.jours_reserves, 0),
    jours_annules: toNumber(c.jours_annules, 0),
    dernier_credit_mensuel: c.dernier_credit_mensuel || null,
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

async function recalculateCountersProrata({
  annee,
  entrepriseId = null,
  apply = false,
  onlyMissingHiringDate = false,
  previewLimit = 20,
}) {
  const year = Number(annee || getCurrentYear());
  return {
    annee: year,
    entreprise_id: entrepriseId,
    analyzed: 0,
    unchanged: 0,
    skipped: 0,
    to_adjust: 0,
    applied: 0,
    total_delta: 0,
    preview: [],
    disabled: true,
    reason: 'PRORATA_DISABLED',
    message: 'La logique prorata est désactivée. Les congés se pilotent uniquement via le solde acquis et l\'incrément mensuel.',
  };
}

module.exports = {
  computeProratedAcquiredDays,
  ensureCounter,
  initializeUserCounters,
  initQuotaAnnuel,
  ajouterAcquisitionMensuelle,
  getSoldeUtilisateur,
  getSoldesUtilisateur,
  listCountersForUser,
  createOrUpdateCounter,
  deleteCounter,
  recalculateCountersProrata,
};