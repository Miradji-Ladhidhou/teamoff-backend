const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const usersController = require('../controllers/usersController');

// Routes pour la gestion des utilisateurs

// Créer un nouvel utilisateur
router.post(
  '/',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise']),
  usersController.createUser
);

// Récupérer tous les utilisateurs
router.get(
  '/',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise', 'manager']),
  usersController.getAllUsers
);

// Récupérer un utilisateur par ID
router.get(
  '/:id',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise', 'manager', 'employe']),
  usersController.getUserById
);

// Mettre à jour un utilisateur
router.put(
  '/:id',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise']),
  usersController.updateUser
);

// Supprimer un utilisateur
router.delete(
  '/:id',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise']),
  usersController.deleteUser
);

module.exports = router;