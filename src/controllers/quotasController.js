// controllers/quotasController.js
const quotasService = require('../services/quotasService');
const UsageService = require('../services/usageService');

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
    const annee = new Date().getFullYear();
    const solde = await quotasService.getSoldeUtilisateur(utilisateur_id, conge_type_id, annee);
    res.json({ solde });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function getSoldes(req, res) {
  try {
    const { utilisateur_id } = req.params;
    const annee = req.query.annee || new Date().getFullYear();
    const soldes = await quotasService.getSoldesUtilisateur(utilisateur_id, annee);
    res.json({ soldes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
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

module.exports = { initQuota, getSolde, getSoldes, getUsageReport };