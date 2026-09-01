// controllers/quotasController.js
const quotasService = require('../services/quotasService');
const { tryActivateReservations } = require('../services/congesService');
const logger = require('../utils/logger');
const UsageService = require('../services/usageService');
const emailService = require('../services/emailService');
const { Utilisateur, MouvementSolde, CongeType, Conge } = require('../models');
const { Op } = require('sequelize');

async function ensureUserAccess(req, utilisateurId) {
  const utilisateur = await Utilisateur.findByPk(utilisateurId, {
    attributes: ['id', 'entreprise_id'],
  });

  if (!utilisateur) {
    const err = new Error('Utilisateur introuvable');
    err.status = 404;
    throw err;
  }

  if (req.user.role === 'super_admin') {
    return utilisateur;
  }

  const isSelf = req.user.id === utilisateur.id;
  const sameEntreprise = req.user.entreprise_id === utilisateur.entreprise_id;

  if (['employe', 'apprenti'].includes(req.user.role) && !isSelf) {
    const err = new Error('Accès interdit');
    err.status = 403;
    throw err;
  }

  if (!sameEntreprise) {
    const err = new Error('Accès interdit');
    err.status = 403;
    throw err;
  }

  return utilisateur;
}

async function tryActivateCompanyReservations(entrepriseId) {
  const pending = await Conge.findAll({
    attributes: ['utilisateur_id', 'conge_type_id', 'date_debut'],
    where: { entreprise_id: entrepriseId, statut: 'reserve' },
    raw: true,
  });
  const seen = new Set();
  for (const row of pending) {
    const annee = new Date(row.date_debut).getFullYear();
    const key = `${row.utilisateur_id}::${row.conge_type_id}::${annee}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await tryActivateReservations(row.utilisateur_id, row.conge_type_id, annee);
    } catch (e) {
      logger.error('tryActivateReservations error after initQuota', { error: e.message });
    }
  }
}

async function initQuota(req, res, next) {
  try {
    const entrepriseId = req.user.role === 'super_admin'
      ? (req.body?.entreprise_id || req.query?.entreprise_id || null)
      : req.user.entreprise_id;

    if (!entrepriseId) {
      return res.status(400).json({ message: 'entreprise_id est requis' });
    }

    await quotasService.initQuotaAnnuel(entrepriseId, new Date().getFullYear());
    // Tenter d'activer les réservations N+1 couvertes par le report N-1
    await tryActivateCompanyReservations(entrepriseId);
    res.json({ message: 'Quotas annuels initialisés avec succès' });
  } catch (err) {
    next(err);
  }
}

async function getSolde(req, res, next) {
  try {
    const { utilisateur_id, conge_type_id } = req.params;
    await ensureUserAccess(req, utilisateur_id);
    const annee = new Date().getFullYear();
    const solde = await quotasService.getSoldeUtilisateur(utilisateur_id, conge_type_id, annee);
    res.json({ solde });
  } catch (err) {
    next(err);
  }
}

async function getSoldes(req, res, next) {
  try {
    const { utilisateur_id } = req.params;
    await ensureUserAccess(req, utilisateur_id);
    const annee = req.query.annee || new Date().getFullYear();
    const soldes = await quotasService.getSoldesUtilisateur(utilisateur_id, annee);
    res.json({ soldes });
  } catch (err) {
    next(err);
  }
}

async function getUsageReport(req, res, next) {
  try {
    const entrepriseId = req.user.role === 'super_admin'
      ? (req.query.entreprise_id || null)
      : req.user.entreprise_id;
    if (!entrepriseId) return res.status(400).json({ message: 'entreprise_id requis' });
    const report = await UsageService.getUsageReport(entrepriseId);
    res.json({ report });
  } catch (err) {
    next(err);
  }
}

async function getUserCounters(req, res, next) {
  try {
    const { utilisateur_id } = req.params;
    const utilisateur = await ensureUserAccess(req, utilisateur_id);

    const annee = Number(req.query.annee || new Date().getFullYear());
    const entrepriseId = req.user.role === 'super_admin' ? utilisateur.entreprise_id : req.user.entreprise_id;
    const items = await quotasService.listCountersForUser(entrepriseId, utilisateur_id, annee);
    res.json({ items, annee });
  } catch (err) {
    next(err);
  }
}

async function upsertUserCounter(req, res, next) {
  try {
    const { utilisateur_id } = req.params;
    const utilisateur = await ensureUserAccess(req, utilisateur_id);

    const annee = Number(req.body?.annee || req.query?.annee || new Date().getFullYear());
    const congeTypeId = req.body?.conge_type_id;
    if (!congeTypeId) {
      return res.status(400).json({ message: 'conge_type_id est requis' });
    }

    const entrepriseId = req.user.role === 'super_admin' ? utilisateur.entreprise_id : req.user.entreprise_id;
    const { compteur, before, after } = await quotasService.createOrUpdateCounter({
      entrepriseId,
      utilisateurId: utilisateur_id,
      congeTypeId,
      annee,
      values: req.body,
      performedBy: req.user,
      req,
    });

    if (before.jours_acquis !== after.jours_acquis) {
      const [congeType, utilisateurFull] = await Promise.all([
        CongeType.findByPk(congeTypeId, { attributes: ['libelle'] }),
        Utilisateur.findByPk(utilisateur_id, { attributes: ['id', 'email', 'prenom', 'nom'] }),
      ]);
      emailService.sendBalanceAdjusted(
        utilisateurFull,
        congeType?.libelle || 'Congé',
        before.jours_acquis,
        after.jours_acquis
      ).catch((e) => logger.error('sendBalanceAdjusted error', { error: e.message }));
    }

    const activationResult = await tryActivateReservations(utilisateur_id, congeTypeId, annee);

    res.json({
      message: 'Compteur mis à jour',
      item: compteur,
      reservations_activees: activationResult.activated,
      reservations_en_attente: activationResult.still_pending,
    });
  } catch (err) {
    next(err);
  }
}

async function removeUserCounter(req, res, next) {
  try {
    const { counter_id } = req.params;
    await quotasService.deleteCounter({
      entrepriseId: req.user.role === 'super_admin' ? null : req.user.entreprise_id,
      counterId: counter_id,
      performedBy: req.user,
      req,
    });

    res.json({ message: 'Compteur supprimé' });
  } catch (err) {
    next(err);
  }
}

async function recalculateProrata(req, res, next) {
  try {
    const annee = Number(req.body?.annee || req.query?.annee || new Date().getFullYear());
    const apply = req.body?.apply === true || req.query?.apply === 'true';
    const onlyMissingHiringDate = req.body?.only_missing_hiring_date === true || req.query?.only_missing_hiring_date === 'true';

    let entrepriseId = null;
    if (req.user.role === 'super_admin') {
      entrepriseId = req.body?.entreprise_id || req.query?.entreprise_id || null;
    } else {
      entrepriseId = req.user.entreprise_id;
    }

    const result = await quotasService.recalculateCountersProrata({
      annee,
      entrepriseId,
      apply,
      onlyMissingHiringDate,
      previewLimit: 30,
    });

    res.json({
      message: result?.disabled
        ? result.message
        : apply
          ? 'Régularisation prorata appliquée avec succès.'
          : 'Simulation prorata effectuée.',
      ...result,
    });
  } catch (err) {
    next(err);
  }
}

async function monthlyAccrual(req, res, next) {
  try {
    const annee = Number(req.body?.annee || req.query?.annee || new Date().getFullYear());
    const mois = Number(req.body?.mois || req.query?.mois || (new Date().getMonth() + 1));
    const apply = req.body?.apply === true || req.query?.apply === 'true';

    const entrepriseId = req.user.role === 'super_admin'
      ? (req.body?.entreprise_id || req.query?.entreprise_id || null)
      : req.user.entreprise_id;

    if (!entrepriseId) {
      return res.status(400).json({ message: 'entreprise_id est requis pour super_admin' });
    }

    const result = await quotasService.ajouterAcquisitionMensuelle(entrepriseId, annee, mois, {
      apply,
      previewLimit: 30,
    });

    res.json({
      message: apply
        ? 'Crédit mensuel appliqué avec succès.'
        : 'Simulation de crédit mensuel effectuée.',
      ...result,
    });
  } catch (err) {
    next(err);
  }
}

async function getHistorique(req, res, next) {
  try {
    const { utilisateur_id } = req.params;
    const reqUser = req.user;

    const utilisateur = await Utilisateur.findByPk(utilisateur_id, { attributes: ['id', 'entreprise_id'] });
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

    const isSelf = reqUser.id === utilisateur_id;
    const isAdmin = ['admin_entreprise', 'super_admin', 'manager'].includes(reqUser.role);
    if (!isSelf && !isAdmin) return res.status(403).json({ message: 'Accès interdit' });
    if (isAdmin && reqUser.role !== 'super_admin' && reqUser.entreprise_id !== utilisateur.entreprise_id) {
      return res.status(403).json({ message: 'Accès interdit' });
    }

    const annee = req.query.annee ? parseInt(req.query.annee, 10) : new Date().getFullYear();
    const conge_type_id = req.query.conge_type_id || null;
    const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const where = { utilisateur_id, annee };
    if (conge_type_id) where.conge_type_id = conge_type_id;

    const { count, rows } = await MouvementSolde.findAndCountAll({
      where,
      include: [{ model: CongeType, as: 'conge_type', attributes: ['id', 'libelle'] }],
      order: [['date', 'DESC'], ['created_at', 'DESC']],
      limit,
      offset,
    });

    return res.json({ total: count, page, limit, items: rows });
  } catch (err) {
    next(err);
  }
}

async function getHistoriqueEntreprise(req, res, next) {
  try {
    const reqUser = req.user;
    if (!['admin_entreprise', 'super_admin'].includes(reqUser.role)) {
      return res.status(403).json({ message: 'Accès interdit' });
    }

    const entrepriseId = reqUser.role === 'super_admin'
      ? (req.query.entreprise_id || null)
      : reqUser.entreprise_id;

    if (!entrepriseId) return res.status(400).json({ message: 'entreprise_id requis' });

    const annee        = req.query.annee ? parseInt(req.query.annee, 10) : new Date().getFullYear();
    const conge_type_id = req.query.conge_type_id || null;
    const limit        = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 2000);
    const page         = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset       = (page - 1) * limit;

    const where = { entreprise_id: entrepriseId, annee };
    if (conge_type_id) where.conge_type_id = conge_type_id;

    const { count, rows } = await MouvementSolde.findAndCountAll({
      where,
      include: [
        { model: CongeType,    as: 'conge_type',  attributes: ['id', 'libelle'] },
        { model: Utilisateur,  as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'service'] },
      ],
      order: [['date', 'DESC'], ['created_at', 'DESC']],
      limit,
      offset,
    });

    return res.json({ total: count, page, limit, items: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  initQuota,
  getSolde,
  getSoldes,
  getUsageReport,
  getUserCounters,
  upsertUserCounter,
  removeUserCounter,
  recalculateProrata,
  monthlyAccrual,
  getHistorique,
  getHistoriqueEntreprise,
};