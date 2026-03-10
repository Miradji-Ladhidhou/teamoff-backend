const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const { creerConge, calcJoursConges } = require('../services/congesService');
const { Conge } = require('../models');

// ----------------------------
// Créer une demande de congé
// ----------------------------
router.post(
  '/demande',
  authJwt,
  authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']),
  async (req, res, next) => {
    try {
      const conge = await creerConge({ ...req.body, reqUser: req.user });
      res.status(201).json({ conge });
    } catch (err) { next(err); }
  }
);

// ----------------------------
// Lister tous les congés de l'utilisateur connecté
// ----------------------------
router.get(
  '/',
  authJwt,
  authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']),
  async (req, res, next) => {
    try {
      const where = req.user.role === 'super_admin' ? {} : { entreprise_id: req.user.entreprise_id };
      const conges = await Conge.findAll({ where });
      res.json(conges);
    } catch (err) { next(err); }
  }
);

// ----------------------------
// Détail d'un congé
// ----------------------------
router.get(
  '/:id',
  authJwt,
  authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']),
  async (req, res, next) => {
    try {
      const conge = await Conge.findOne({ 
        where: { id: req.params.id, entreprise_id: req.user.entreprise_id } 
      });
      if (!conge) return res.status(404).json({ message: 'Congé introuvable' });
      res.json(conge);
    } catch (err) { next(err); }
  }
);

// ----------------------------
// Mise à jour d'un congé (ex: modifier dates avant validation)
// ----------------------------
router.put(
  '/:id',
  authJwt,
  authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']),
  async (req, res, next) => {
    try {
      const conge = await Conge.findOne({ 
        where: { id: req.params.id, entreprise_id: req.user.entreprise_id } 
      });
      if (!conge) return res.status(404).json({ message: 'Congé introuvable' });

      // Exemple simple : on peut ajouter la logique d'autorisation selon statut
      await conge.update(req.body);
      res.json(conge);
    } catch (err) { next(err); }
  }
);

// ----------------------------
// historique des congés (audit)
// ----------------------------
router.get(
  '/:id/audit',
  authJwt,
  authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']),
  async (req, res, next) => {
    try {
      const conge = await Conge.findOne({ 
        where: { id: req.params.id, entreprise_id: req.user.entreprise_id } 
      });
      if (!conge) return res.status(404).json({ message: 'Congé introuvable' });

      // Récupérer les logs d'audit liés à ce congé
      const audits = await getAuditLogsForConge(conge.id);
      res.json(audits);
    } catch (err) { next(err); }
  }
);

// ----------------------------
// Supprimer / annuler un congé
// ----------------------------
router.delete(
  '/:id',
  authJwt,
  authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']),
  async (req, res, next) => {
    try {
      const conge = await Conge.findOne({ 
        where: { id: req.params.id, entreprise_id: req.user.entreprise_id } 
      });
      if (!conge) return res.status(404).json({ message: 'Congé introuvable' });

      await conge.destroy();
      res.status(204).send();
    } catch (err) { next(err); }
  }
);

module.exports = router;