// Middleware de métriques basiques
const jwt = require('jsonwebtoken');
const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');
const { Entreprise } = require('../models');

const startedAt = Date.now();

const metrics = {
  requests: 0,
  errors: 0,
  errors4xx: 0,
  errors5xx: 0,
  responseTimes: [],
  enterpriseUsage: new Map()
};

const getEntrepriseIdFromRequest = (req) => {
  if (req.user?.entreprise_id) {
    return req.user.entreprise_id;
  }

  const authHeader = req.headers?.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.entreprise_id || null;
  } catch (_) {
    return null;
  }
};

const metricsMiddleware = (req, res, next) => {
  const start = Date.now();
  metrics.requests++;

  // Incrémenter l'usage par entreprise
  const entrepriseId = getEntrepriseIdFromRequest(req);
  if (entrepriseId) {
    const count = metrics.enterpriseUsage.get(entrepriseId) || 0;
    metrics.enterpriseUsage.set(entrepriseId, count + 1);
  }

  res.on('finish', () => {
    const duration = Date.now() - start;
    metrics.responseTimes.push(duration);

    // Garder seulement les 100 dernières mesures
    if (metrics.responseTimes.length > 100) {
      metrics.responseTimes.shift();
    }

    if (res.statusCode >= 400) {
      metrics.errors++;
      if (res.statusCode >= 400 && res.statusCode < 500) {
        metrics.errors4xx++;
      }
      if (res.statusCode >= 500) {
        metrics.errors5xx++;
      }
    }
  });

  next();
};

// Route pour consulter les métriques (admin seulement)
const getMetrics = async (req, res) => {
  const avgResponseTime = metrics.responseTimes.length > 0
    ? metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length
    : 0;

  const minResponseTime = metrics.responseTimes.length > 0
    ? Math.min(...metrics.responseTimes)
    : 0;

  const maxResponseTime = metrics.responseTimes.length > 0
    ? Math.max(...metrics.responseTimes)
    : 0;

  const elapsedMinutes = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
  const requestsPerMinute = Number((metrics.requests / elapsedMinutes).toFixed(2));

  let dbConnections = 0;
  try {
    const rows = await sequelize.query(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()',
      { type: QueryTypes.SELECT }
    );
    dbConnections = Number(rows?.[0]?.count || 0);
  } catch (_) {
    dbConnections = 0;
  }

  const enterpriseUsageMap = Object.fromEntries(metrics.enterpriseUsage);
  const entrepriseIds = Object.keys(enterpriseUsageMap);
  let enterpriseUsage = [];

  if (entrepriseIds.length > 0) {
    const entreprises = await Entreprise.findAll({
      where: { id: entrepriseIds },
      attributes: ['id', 'nom'],
    });

    const entreprisesById = new Map(entreprises.map((e) => [e.id, e.nom]));
    enterpriseUsage = entrepriseIds.map((entreprise_id) => ({
      entreprise_id,
      entreprise_nom: entreprisesById.get(entreprise_id) || null,
      count: Number(enterpriseUsageMap[entreprise_id] || 0),
    }));
  }

  res.json({
    uptime: Math.floor(process.uptime()),
    memoryUsage: process.memoryUsage().heapUsed,
    requests: metrics.requests,
    avgResponseTime: Math.round(avgResponseTime),
    minResponseTime,
    maxResponseTime,
    requestsPerMinute,
    activeConnections: 0,
    dbConnections,
    dbQueries: 0,
    cacheHitRate: 0,
    error4xx: metrics.errors4xx,
    error5xx: metrics.errors5xx,
    errorRate: metrics.requests > 0 ? (metrics.errors / metrics.requests) : 0,
    enterpriseUsage,

    // Champs historiques conservés pour compatibilité
    totalRequests: metrics.requests,
    totalErrors: metrics.errors,
    averageResponseTime: Math.round(avgResponseTime),
    enterpriseUsageLegacy: enterpriseUsageMap
  });
};

module.exports = { metricsMiddleware, getMetrics };