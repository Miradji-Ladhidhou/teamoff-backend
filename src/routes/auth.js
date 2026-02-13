const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Utilisateur } = require('../models');

require('dotenv').config();

// -------------------------------
// Rate limiter pour le login
// -------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limite à 5 tentatives par IP
  standardHeaders: true, // Retourne info rate-limit dans headers
  legacyHeaders: false,
  message: {
    message: 'Trop de tentatives. Réessayez dans 15 minutes.'
  },
});

// POST /auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password, entreprise_id } = req.body;

  try {
    const user = await Utilisateur.findOne({ where: { email } });
    if (!user) return res.status(401).json({ message: 'Utilisateur non trouvé' });

    // Multi-tenant check (optionnel)
    if (entreprise_id && user.entreprise_id !== entreprise_id) {
      return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
    }

    // Gestion des status 
    switch (user.statut) {
      case 'en_attente':
        return res.status(403).json({ message: 'Votre compte est en attente de validation.' });
      case 'inactif':
        return res.status(403).json({ message: 'Votre compte est désactivé. Contactez l\'administrateur.' });
      case 'actif':
        break; 
      default:
        return res.status(403).json({ message: 'Statut utilisateur inconnu.' });
    }

    // Vérification du mot de passe
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(401).json({ message: 'Mot de passe incorrect' });

    // Génération du token JWT
    const payload = { id: user.id, role: user.role, entreprise_id: user.entreprise_id };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '1d',
    });

    res.json({ token, utilisateur: { id: user.id, nom: user.nom, email: user.email, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

module.exports = router;
