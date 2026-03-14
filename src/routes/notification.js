// /routes/notificationRoutes.js
const express = require('express');
const router = express.Router();

const authJwt = require('../middlewares/authJwt');
const notificationController = require('../controllers/notificationController');

router.use(authJwt);

/**
 * Liste des notifications
 */
router.get('/', notificationController.getNotifications);

/**
 * Marquer une notification comme lue
 */
router.put('/:id/lue', notificationController.marquerCommeLue);

/**
 * Tout marquer comme lu
 */
router.put('/lire-tout', notificationController.toutMarquerCommeLue);

module.exports = router;