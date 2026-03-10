// controllers/joursFeriesController.js
const { JoursFeries, sequelize } = require('../models');
const { auditFerie } = require('../services/auditHelper');

// ----------------------------
// Lister tous les jours fériés
// ----------------------------
async function listerJoursFeries(req, res) {
  try {
    const joursFeries = await JoursFeries.findAll({
      where: { entreprise_id: req.user.entreprise_id },
      order: [['date', 'ASC']]
    });
    res.json(joursFeries);
  } catch (err) {
    res.status(500).json({ message: "Erreur serveur", error: err.message });
  }
}

// ----------------------------
// Création d'un jour férié
// ----------------------------
async function creerJourFerie(req, res) {
  const t = await sequelize.transaction();
  try {
    const { date, libelle } = req.body;

    const jourFerie = await JoursFeries.create({
      entreprise_id: req.user.entreprise_id,
      date,
      libelle
    }, { transaction: t });

    await auditFerie.created(jourFerie, req.user, req, { transaction: t });

    await t.commit();
    res.status(201).json(jourFerie);
  } catch (err) {
    await t.rollback();
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
  const t = await sequelize.transaction();
  try {
    const { date, libelle } = req.body;

    const jourFerie = await JoursFeries.findOne({
      where: { id: req.params.id, entreprise_id: req.user.entreprise_id },
      transaction: t
    });
    if (!jourFerie) throw new Error("Jour férié introuvable");

    const oldData = { libelle: jourFerie.libelle, date: jourFerie.date };

    await jourFerie.update({ date, libelle }, { transaction: t });

    await auditFerie.updated(jourFerie, req.user, req, { oldData, updates: { date, libelle }, transaction: t });

    await t.commit();
    res.json(jourFerie);
  } catch (err) {
    await t.rollback();
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
  const t = await sequelize.transaction();
  try {
    const jourFerie = await JoursFeries.findOne({
      where: { id: req.params.id, entreprise_id: req.user.entreprise_id },
      transaction: t
    });
    if (!jourFerie) throw new Error("Jour férié introuvable");

    await jourFerie.destroy({ transaction: t });

    await auditFerie.deleted(jourFerie, req.user, req, { transaction: t });

    await t.commit();
    res.status(204).send();
  } catch (err) {
    await t.rollback();
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