const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Utilisateur, Entreprise } = require('../models');
require('dotenv').config();

// -------------------------------
// Rate limiter pour le login
// -------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Trop de tentatives. Réessayez dans 15 minutes.'
  },
});

// POST /auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password, entreprise_id } = req.body;

  try {
    // Recherche utilisateur avec multi-tenant (optionnel)
    const whereClause = entreprise_id ? { email, entreprise_id } : { email };
    const user = await Utilisateur.findOne({ where: whereClause });
    if (!user) return res.status(401).json({ message: 'Utilisateur non trouvé' });

    // Vérification que l'entreprise est active
    const entreprise = await Entreprise.findByPk(user.entreprise_id);
    if (!entreprise || entreprise.statut !== 'active') {
      return res.status(403).json({ message: 'Entreprise inactive ou suspendue.' });
    }

    // Gestion des statuts utilisateurs
    if (user.statut === 'en_attente') {
      return res.status(403).json({ message: 'Votre compte est en attente de validation.' });
    }
    if (user.statut === 'inactif') {
      return res.status(403).json({ message: 'Votre compte est désactivé. Contactez l\'administrateur.' });
    }

    // Vérification du mot de passe
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(401).json({ message: 'Mot de passe incorrect' });

    // Génération du token JWT
    const payload = { id: user.id, role: user.role, entreprise_id: user.entreprise_id };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '1d',
    });

    // Retour sécurisé
    res.json({
      token,
      utilisateur: {
        id: user.id,
        nom: user.nom,
        email: user.email,
        role: user.role,
        entreprise_id: user.entreprise_id
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

module.exports = router;
