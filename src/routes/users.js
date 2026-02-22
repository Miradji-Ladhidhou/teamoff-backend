const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { Utilisateur, Entreprise } = require('../models');
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/roles');

// ============================
// CREATE utilisateur
// ============================
router.post(
  '/',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise']),
  async (req, res) => {
    const { nom, email, password, role, entreprise_id } = req.body;
    const user = req.user;

    // Vérifications hiérarchiques
    if (user.role === 'admin_entreprise' && !['manager', 'employe'].includes(role)) {
      return res.status(403).json({ message: 'Vous ne pouvez créer que manager ou employe' });
    }

    if (user.role === 'admin_entreprise' && entreprise_id !== user.entreprise_id) {
      return res.status(403).json({ message: 'Vous ne pouvez créer des utilisateurs que dans votre entreprise' });
    }

    try {
      const hash = await bcrypt.hash(password, 10);
      const newUser = await Utilisateur.create({
        nom,
        email,
        role,
        entreprise_id,
        password_hash: hash,
        statut: 'en_attente',
      });

      res.status(201).json({
        id: newUser.id,
        nom: newUser.nom,
        email: newUser.email,
        role: newUser.role,
        entreprise_id: newUser.entreprise_id,
        statut: newUser.statut,
      });
    } catch (err) {
      console.error('Erreur création utilisateur:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// ============================
// READ utilisateurs
// ============================
router.get(
  '/',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise', 'manager']),
  async (req, res) => {
    try {
      let where = {};
      if (req.user.role === 'admin_entreprise' || req.user.role === 'manager') {
        where.entreprise_id = req.user.entreprise_id;
      }

      const users = await Utilisateur.findAll({ where, order: [['nom', 'ASC']] });
      res.json(users);
    } catch (err) {
      console.error('Erreur récupération utilisateurs:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// ============================
// READ ONE utilisateur
// ============================
router.get(
  '/:id',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise', 'manager', 'employe']),
  async (req, res) => {
    try {
      const utilisateur = await Utilisateur.findByPk(req.params.id);
      if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

      // Multi-tenant check
      if (req.user.role === 'admin_entreprise' || req.user.role === 'manager' || req.user.role === 'employe') {
        if (utilisateur.entreprise_id !== req.user.entreprise_id && req.user.role !== 'super_admin') {
          return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
        }
      }

      res.json(utilisateur);
    } catch (err) {
      console.error('Erreur récupération utilisateur:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// ============================
// UPDATE utilisateur
// ============================
router.put(
  '/:id',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise']),
  async (req, res) => {
    try {
      const utilisateur = await Utilisateur.findByPk(req.params.id);
      if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

      // Multi-tenant check pour admin_entreprise
      if (req.user.role === 'admin_entreprise' && utilisateur.entreprise_id !== req.user.entreprise_id) {
        return res.status(403).json({ message: 'Vous ne pouvez modifier que les utilisateurs de votre entreprise' });
      }

      const { nom, email, role, statut, password } = req.body;

      // Vérification rôle
      if (req.user.role === 'admin_entreprise' && role && !['manager', 'employe'].includes(role)) {
        return res.status(403).json({ message: 'Vous ne pouvez attribuer que manager ou employe' });
      }

      if (password) {
        utilisateur.password_hash = await bcrypt.hash(password, 10);
      }

      await utilisateur.update({ nom, email, role, statut });

      res.json(utilisateur);
    } catch (err) {
      console.error('Erreur mise à jour utilisateur:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// ============================
// DELETE utilisateur
// ============================
router.delete(
  '/:id',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise']),
  async (req, res) => {
    try {
      const utilisateur = await Utilisateur.findByPk(req.params.id);
      if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

      // Multi-tenant check pour admin_entreprise
      if (req.user.role === 'admin_entreprise' && utilisateur.entreprise_id !== req.user.entreprise_id) {
        return res.status(403).json({ message: 'Vous ne pouvez supprimer que les utilisateurs de votre entreprise' });
      }

      await utilisateur.destroy();
      res.json({ message: 'Utilisateur supprimé avec succès' });
    } catch (err) {
      console.error('Erreur suppression utilisateur:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

module.exports = router;
