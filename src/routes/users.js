const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const multer = require('multer');

const { advancedRateLimiter } = require('../middlewares/advancedRateLimiter');
const usersController = require('../controllers/usersController');
const { importUsersCSV } = require('../controllers/usersImportController');

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Routes pour la gestion des utilisateurs

// Créer un nouvel utilisateur

// Création utilisateur (pas de rate limit strict, réservé admin)
router.post(
  '/',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise']),
  usersController.createUser
);

// Récupérer tous les utilisateurs

// GET utilisateurs (rate limit permissif)
router.get(
  '/',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise', 'manager']),
  advancedRateLimiter('getData'),
  usersController.getAllUsers
);

// Récupérer un utilisateur par ID

router.get(
  '/:id',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise', 'manager', 'employe']),
  advancedRateLimiter('getData'),
  usersController.getUserById
);

// Mettre à jour un utilisateur
router.put(
  '/:id',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise']),
  usersController.updateUser
);

// Changer le rôle d'un utilisateur
router.put(
  '/:id/role',
  authJwt,
  authorizeRole(['super_admin']),
  usersController.changeUserRole
);

// Import CSV utilisateurs
router.post(
  '/import/csv',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise']),
  csvUpload.single('file'),
  importUsersCSV
);

// Supprimer un utilisateur
router.delete(
  '/:id',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise']),
  usersController.deleteUser
);

module.exports = router;