const { JoursFeries } = require('../models');
const joursFeriesService = require('../services/joursFeriesService');

// ----------------------------
// Liste tous les jours fériés
// ----------------------------
async function listerJoursFeries(req, res) {
  try {
    const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(req.user.entreprise_id);
    res.json(joursFeries);
  } catch (err) {
    res.status(500).json({ message: "Erreur serveur", error: err.message });
  }
}

// ----------------------------
// Création d'un jour férié
// ----------------------------
async function creerJourFerie(req, res) {
  const { date, libelle, recurrent } = req.body;
  try {
    const jourFerie = await JoursFeries.create({
      entreprise_id: req.user.entreprise_id,
      date,
      libelle,
      recurrent: !!recurrent
    });
    res.status(201).json(jourFerie);
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ message: "Jour férié déjà existant" });
    }
    res.status(500).json({ message: "Erreur serveur", error: err.message });
  }
}

// ----------------------------
// Détail d'un jour férié
// ----------------------------
async function getJourFerie(req, res) {
  try {
    const jourFerie = await JoursFeries.findOne({
      where: { id: req.params.id, entreprise_id: req.user.entreprise_id }
    });
    if (!jourFerie) return res.status(404).json({ message: "Jour férié introuvable" });
    res.json(jourFerie);
  } catch (err) {
    res.status(500).json({ message: "Erreur serveur", error: err.message });
  }
}

// ----------------------------
// Mise à jour d'un jour férié
// ----------------------------
async function updateJourFerie(req, res) {
  const { date, libelle, recurrent } = req.body;
  try {
    const jourFerie = await JoursFeries.findOne({
      where: { id: req.params.id, entreprise_id: req.user.entreprise_id }
    });
    if (!jourFerie) return res.status(404).json({ message: "Jour férié introuvable" });

    await jourFerie.update({ date, libelle, recurrent: !!recurrent });
    res.json(jourFerie);
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ message: "Jour férié déjà existant" });
    }
    res.status(500).json({ message: "Erreur serveur", error: err.message });
  }
}

// ----------------------------
// Suppression d'un jour férié
// ----------------------------
async function supprimerJourFerie(req, res) {
  try {
    const jourFerie = await JoursFeries.findOne({
      where: { id: req.params.id, entreprise_id: req.user.entreprise_id }
    });
    if (!jourFerie) return res.status(404).json({ message: "Jour férié introuvable" });

    await jourFerie.destroy();
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ message: "Erreur serveur", error: err.message });
  }
}

module.exports = {
  listerJoursFeries,
  creerJourFerie,
  getJourFerie,
  updateJourFerie,
  supprimerJourFerie
};