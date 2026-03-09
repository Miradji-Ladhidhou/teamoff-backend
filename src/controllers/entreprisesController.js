const { Entreprise } = require('../models');
const { validationResult } = require('express-validator');

async function createEntreprise(req, res) {
  const { nom, logo } = req.body;
  if (!nom) return res.status(400).json({ message: 'Nom requis' });

  try {
    const entreprise = await Entreprise.create(
      { nom, logo },
      { userId: req.user.id }
    );
    res.status(201).json(entreprise);
  } catch (err) {
    console.error('Erreur création entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function getAllEntreprises(req, res) {
  try {
    const entreprises = await Entreprise.findAll({ order: [['nom', 'ASC']] });
    res.json(entreprises);
  } catch (err) {
    console.error('Erreur récupération entreprises:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function getEntrepriseById(req, res) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });
    res.json(entreprise);
  } catch (err) {
    console.error('Erreur récupération entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function updateEntreprise(req, res) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    await entreprise.update(req.body, { userId: req.user.id });
    res.json(entreprise);
  } catch (err) {
    console.error('Erreur mise à jour entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function deleteEntreprise(req, res) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    await entreprise.destroy({ userId: req.user.id });
    res.json({ message: 'Entreprise supprimée' });
  } catch (err) {
    console.error('Erreur suppression entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function patchStatutEntreprise(req, res) {
  const { statut } = req.body;
  const allowed = ['active', 'inactive', 'suspendue'];
  if (!allowed.includes(statut)) return res.status(400).json({ message: 'Statut invalide' });

  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    await entreprise.update({ statut }, { userId: req.user.id });
    res.json({ message: 'Statut entreprise mis à jour', entreprise });
  } catch (err) {
    console.error('Erreur mise à jour statut:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function getPolitiqueConges(req, res) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    res.json({ politique_conges: entreprise.politique_conges });
  } catch (err) {
    console.error('Erreur récupération politique:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

async function updatePolitiqueConges(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    entreprise.politique_conges = { ...entreprise.politique_conges, ...req.body.politique_conges };
    await entreprise.save({ userId: req.user.id });

    res.json({ message: 'Politique de congés mise à jour', politique_conges: entreprise.politique_conges });
  } catch (err) {
    console.error('Erreur mise à jour politique:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = {
  createEntreprise,
  getAllEntreprises,
  getEntrepriseById,
  updateEntreprise,
  deleteEntreprise,
  patchStatutEntreprise,
  getPolitiqueConges,
  updatePolitiqueConges
};