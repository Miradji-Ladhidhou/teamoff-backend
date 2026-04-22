const express = require('express');
const router = express.Router();

const authJwt = require('../middlewares/authJwt');
const notificationController = require('../controllers/notificationController');
const { addClient, removeClient } = require('../services/sseManager');

/**
 * SSE stream — push real-time notifications
 * EventSource doesn't support custom headers, so we accept token via query param here only.
 * This route is intentionally placed BEFORE router.use(authJwt) to bypass header-only auth.
 */
router.get('/stream', async (req, res) => {
  const jwt = require('jsonwebtoken');
  const { Utilisateur, Entreprise } = require('../models');
  const token = req.query.token;
  if (!token) return res.status(401).end();
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type === 'reset' || decoded.type === 'refresh') return res.status(401).end();
    const user = await Utilisateur.findByPk(decoded.id);
    if (!user || user.statut === 'inactif' || user.statut === 'en_attente') return res.status(403).end();
    const entreprise = await Entreprise.findByPk(user.entreprise_id);
    if (!entreprise || entreprise.statut !== 'active') return res.status(403).end();
    req.user = { id: user.id, role: user.role, entreprise_id: user.entreprise_id };
  } catch {
    return res.status(401).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send a heartbeat comment every 25s to keep the connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  addClient(req.user.id, res);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(req.user.id, res);
  });
});

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