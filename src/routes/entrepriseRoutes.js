const express = require('express');
const router = express.Router();
const { Entreprise } = require('../models');
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const { body, validationResult } = require('express-validator');

// ---------------------------
// CREATE - Super admin uniquement
// ---------------------------
router.post(
  '/',
  authJwt,
  authorizeRole(['super_admin']),
  async (req, res) => {
    const { nom, logo } = req.body;
    if (!nom) return res.status(400).json({ message: 'Nom requis' });

    try {
      const entreprise = await Entreprise.create({ nom, logo });
      res.status(201).json(entreprise);
    } catch (err) {
      console.error('Erreur création entreprise:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// ---------------------------
// READ ALL - Super admin uniquement
// ---------------------------
router.get(
  '/',
  authJwt,
  authorizeRole(['super_admin']),
  async (req, res) => {
    try {
      const entreprises = await Entreprise.findAll({ order: [['nom','ASC']] });
      res.json(entreprises);
    } catch (err) {
      console.error('Erreur récupération entreprises:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// ---------------------------
// READ ONE - Super admin ou admin de sa propre entreprise
// ---------------------------
router.get(
  '/:id',
  authJwt,
  authorizeRole(['super_admin','admin_entreprise'], req => req.params.id),
  async (req, res) => {
    try {
      const entreprise = await Entreprise.findByPk(req.params.id);
      if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });
      res.json(entreprise);
    } catch (err) {
      console.error('Erreur récupération entreprise:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// ---------------------------
// UPDATE - Super admin uniquement
// ---------------------------
router.put(
  '/:id',
  authJwt,
  authorizeRole(['super_admin']),
  async (req, res) => {
    try {
      const entreprise = await Entreprise.findByPk(req.params.id);
      if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

      await entreprise.update(req.body);
      res.json(entreprise);
    } catch (err) {
      console.error('Erreur mise à jour entreprise:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// ---------------------------
// DELETE - Super admin uniquement
// ---------------------------
router.delete(
  '/:id',
  authJwt,
  authorizeRole(['super_admin']),
  async (req, res) => {
    try {
      const entreprise = await Entreprise.findByPk(req.params.id);
      if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

      await entreprise.destroy();
      res.json({ message: 'Entreprise supprimée' });
    } catch (err) {
      console.error('Erreur suppression entreprise:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// ---------------------------
// PATCH : Statut entreprise - Super admin uniquement
// ---------------------------
router.patch(
  '/:id/statut',
  authJwt,
  authorizeRole(['super_admin']),
  async (req, res) => {
    const { statut } = req.body;
    const allowed = ['active','inactive','suspendue'];
    if (!allowed.includes(statut)) return res.status(400).json({ message: 'Statut invalide' });

    try {
      const entreprise = await Entreprise.findByPk(req.params.id);
      if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

      await entreprise.update({ statut });
      res.json({ message: 'Statut entreprise mis à jour', entreprise });
    } catch (err) {
      console.error('Erreur mise à jour statut:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// ---------------------------
// GET : Politique de congés
// ---------------------------
router.get(
  '/:id/politique',
  authJwt,
  authorizeRole(['super_admin','admin_entreprise'], req => req.user.entreprise_id),
  async (req, res) => {
    try {
      const entreprise = await Entreprise.findByPk(req.params.id);
      if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

      res.json({ politique_conges: entreprise.politique_conges });
    } catch (err) {
      console.error('Erreur récupération politique:', err);
      res.status(500).json({ message: 'Erreur serveur' });
    }
  }
);

// ---------------------------
// PUT : Mettre à jour une politique de congés
// ---------------------------
router.put(
  '/:id/politique',
  authJwt,
  authorizeRole(['super_admin','admin_entreprise'], req => req.user.entreprise_id),
  body('politique_conges').isObject().withMessage('Politique_conges doit être un objet JSON'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const entreprise = await Entreprise.findByPk(req.params.id);
      if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

      entreprise.politique_conges = { ...entreprise.politique_conges, ...req.body.politique_conges };
      await entreprise.save();

      res.json({ message: 'Politique de congés mise à jour', politique_conges: entreprise.politique_conges });
    } catch (err) {
      console.error('Erreur mise à jour politique:', err);
      res.status(500).json({ message: 'Erreur serveur' });
    }
  }
);

module.exports = router;
