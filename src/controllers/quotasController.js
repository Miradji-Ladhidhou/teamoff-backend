// controllers/quotasController.js
const quotasService = require('../services/quotasService');

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

module.exports = { initQuota, getSolde };