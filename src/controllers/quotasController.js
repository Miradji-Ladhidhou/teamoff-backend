// controllers/quotasController.js
const quotasService = require('../services/quotasService');
const UsageService = require('../services/usageService');
const { Utilisateur } = require('../models');

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

  if (req.user.role === 'employe' && !isSelf) {
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

async function initQuota(req, res) {
  try {
    await quotasService.initQuotaAnnuel(req.user.entreprise_id, new Date().getFullYear());
    res.json({ message: 'Quotas annuels initialisés avec succès' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function getSolde(req, res) {
  try {
    const { utilisateur_id, conge_type_id } = req.params;
    await ensureUserAccess(req, utilisateur_id);
    const annee = new Date().getFullYear();
    const solde = await quotasService.getSoldeUtilisateur(utilisateur_id, conge_type_id, annee);
    res.json({ solde });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function getSoldes(req, res) {
  try {
    const { utilisateur_id } = req.params;
    await ensureUserAccess(req, utilisateur_id);
    const annee = req.query.annee || new Date().getFullYear();
    const soldes = await quotasService.getSoldesUtilisateur(utilisateur_id, annee);
    res.json({ soldes });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function getUsageReport(req, res) {
  try {
    const entrepriseId = req.user.entreprise_id;
    const report = await UsageService.getUsageReport(entrepriseId);
    res.json({ report });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function getUserCounters(req, res) {
  try {
    const { utilisateur_id } = req.params;
    const utilisateur = await ensureUserAccess(req, utilisateur_id);

    const annee = Number(req.query.annee || new Date().getFullYear());
    const entrepriseId = req.user.role === 'super_admin' ? utilisateur.entreprise_id : req.user.entreprise_id;
    const items = await quotasService.listCountersForUser(entrepriseId, utilisateur_id, annee);
    res.json({ items, annee });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function upsertUserCounter(req, res) {
  try {
    const { utilisateur_id } = req.params;
    const utilisateur = await ensureUserAccess(req, utilisateur_id);

    const annee = Number(req.body?.annee || req.query?.annee || new Date().getFullYear());
    const congeTypeId = req.body?.conge_type_id;
    if (!congeTypeId) {
      return res.status(400).json({ message: 'conge_type_id est requis' });
    }

    const entrepriseId = req.user.role === 'super_admin' ? utilisateur.entreprise_id : req.user.entreprise_id;
    const compteur = await quotasService.createOrUpdateCounter({
      entrepriseId,
      utilisateurId: utilisateur_id,
      congeTypeId,
      annee,
      values: req.body,
    });

    res.json({ message: 'Compteur mis à jour', item: compteur });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function removeUserCounter(req, res) {
  try {
    const { counter_id } = req.params;
    await quotasService.deleteCounter({
      entrepriseId: req.user.role === 'super_admin' ? null : req.user.entreprise_id,
      counterId: counter_id,
    });

    res.json({ message: 'Compteur supprimé' });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ message: 'Erreur serveur', error: err.message });
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
};