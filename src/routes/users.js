const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { Utilisateur } = require('../models');
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/roles');

// Créer un utilisateur
router.post(
  '/',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise']),
  async (req, res) => {
    const { nom, email, password, role, entreprise_id } = req.body;
    const user = req.user;

    // Vérification hiérarchique
    if (user.role === 'admin_entreprise' && role === 'admin_entreprise') {
      return res.status(403).json({ message: 'Vous ne pouvez pas créer un autre admin_entreprise' });
    }

    // Multi-tenant check pour admin_entreprise
    if (user.role === 'admin_entreprise' && entreprise_id !== user.entreprise_id) {
      return res.status(403).json({ message: 'Vous ne pouvez créer des utilisateurs que dans votre entreprise' });
    }

    try {
      const hash = await bcrypt.hash(password, 10);
      const newUser = await Utilisateur.create({
        nom,
        email,
        password_hash: hash,
        role,
        entreprise_id,
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
      console.error(err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

module.exports = router;
