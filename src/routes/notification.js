const express = require('express');
const router = express.Router();

const jwt = require('jsonwebtoken');
const { Utilisateur, Entreprise } = require('../models');
const authJwt = require('../middlewares/authJwt');
const validateUUIDParam = require('../middlewares/validateUUIDParam');
const notificationController = require('../controllers/notificationController');
const { addClient, removeClient } = require('../services/sseManager');
const logger = require('../utils/logger');

// Connexions SSE actives par userId — max 5 onglets simultanés
const SSE_MAX_PER_USER = 5;
const sseConnectionCount = new Map();

/**
 * SSE stream — push real-time notifications
 * EventSource doesn't support custom headers, so we accept token via query param here only.
 * This route is intentionally placed BEFORE router.use(authJwt) to bypass header-only auth.
 */
router.get('/stream', async (req, res) => {
  // Accept token from query param (native EventSource) or Authorization header (fetchEventSource)
  let token = req.query.token;
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
  }
  if (!token) return res.status(401).end();

  let tokenExpiry = 0;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type === 'reset' || decoded.type === 'refresh') return res.status(401).end();

    const user = await Utilisateur.findByPk(decoded.id);
    if (!user || user.statut === 'inactif' || user.statut === 'en_attente') return res.status(403).end();

    const entreprise = await Entreprise.findByPk(user.entreprise_id);
    if (!entreprise || entreprise.statut !== 'active') return res.status(403).end();

    req.user = { id: user.id, role: user.role, entreprise_id: user.entreprise_id };
    tokenExpiry = decoded.exp * 1000; // ms timestamp
  } catch {
    return res.status(401).end();
  }

  // Limite de connexions SSE par utilisateur (protection contre les fuites de FD)
  const userId = req.user.id;
  const current = sseConnectionCount.get(userId) || 0;
  if (current >= SSE_MAX_PER_USER) {
    logger.warn('SSE connexion refusée — limite atteinte', { user_id: userId, count: current });
    return res.status(429).end();
  }
  sseConnectionCount.set(userId, current + 1);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  // Auto-close when access token expires — frontend will receive the event and can refresh
  const msUntilExpiry = tokenExpiry - Date.now();
  const expireTimer = setTimeout(() => {
    try {
      res.write('event: token_expired\ndata: {}\n\n');
      res.end();
    } catch {}
  }, Math.max(1000, msUntilExpiry));

  addClient(userId, res);

  req.on('close', () => {
    clearTimeout(expireTimer);
    clearInterval(heartbeat);
    removeClient(userId, res);
    const remaining = (sseConnectionCount.get(userId) || 1) - 1;
    if (remaining <= 0) {
      sseConnectionCount.delete(userId);
    } else {
      sseConnectionCount.set(userId, remaining);
    }
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
router.put('/:id/lue', validateUUIDParam('id'), notificationController.marquerCommeLue);

/**
 * Tout marquer comme lu
 */
router.put('/lire-tout', notificationController.toutMarquerCommeLue);

module.exports = router;