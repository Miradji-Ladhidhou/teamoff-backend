const express = require('express');
const router = express.Router();
const authorizeRole = require('../middlewares/authorizeRole');
const multer = require('multer');

const { advancedRateLimiter } = require('../middlewares/advancedRateLimiter');
const validateUUIDParam = require('../middlewares/validateUUIDParam');
const validate = require('../middlewares/validate');
const { createUserRules, updateUserRules, changeRoleRules } = require('../validators/users.validators');
const { forUserCreate, forUserUpdate } = require('../middlewares/stripForbiddenFields');
const usersController = require('../controllers/usersController');
const { importUsersCSV } = require('../controllers/usersImportController');

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.post(
  '/',
  authorizeRole(['super_admin', 'admin_entreprise']),
  forUserCreate,
  validate(createUserRules),
  usersController.createUser
);

router.get(
  '/',
  authorizeRole(['super_admin', 'admin_entreprise', 'manager']),
  advancedRateLimiter('getData'),
  usersController.getAllUsers
);

router.get(
  '/:id',
  authorizeRole(['super_admin', 'admin_entreprise', 'manager', 'employe']),
  validateUUIDParam('id'),
  advancedRateLimiter('getData'),
  usersController.getUserById
);

router.put(
  '/:id',
  authorizeRole(['super_admin', 'admin_entreprise']),
  validateUUIDParam('id'),
  forUserUpdate,
  validate(updateUserRules),
  usersController.updateUser
);

router.put(
  '/:id/role',
  authorizeRole(['super_admin']),
  validateUUIDParam('id'),
  validate(changeRoleRules),
  usersController.changeUserRole
);

router.post(
  '/import/csv',
  authorizeRole(['super_admin', 'admin_entreprise']),
  csvUpload.single('file'),
  importUsersCSV
);

router.delete(
  '/:id',
  authorizeRole(['super_admin', 'admin_entreprise']),
  validateUUIDParam('id'),
  usersController.deleteUser
);

module.exports = router;
