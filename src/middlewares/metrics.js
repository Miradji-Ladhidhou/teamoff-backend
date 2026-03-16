// Middleware de métriques basiques
const metrics = {
  requests: 0,
  errors: 0,
  responseTimes: [],
  enterpriseUsage: new Map()
};

const metricsMiddleware = (req, res, next) => {
  const start = Date.now();
  metrics.requests++;

  // Incrémenter l'usage par entreprise
  if (req.user?.entreprise_id) {
    const count = metrics.enterpriseUsage.get(req.user.entreprise_id) || 0;
    metrics.enterpriseUsage.set(req.user.entreprise_id, count + 1);
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
    }
  });

  next();
};

// Route pour consulter les métriques (admin seulement)
const getMetrics = (req, res) => {
  const avgResponseTime = metrics.responseTimes.length > 0
    ? metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length
    : 0;

  res.json({
    totalRequests: metrics.requests,
    totalErrors: metrics.errors,
    averageResponseTime: Math.round(avgResponseTime),
    errorRate: metrics.requests > 0 ? (metrics.errors / metrics.requests * 100).toFixed(2) : 0,
    enterpriseUsage: Object.fromEntries(metrics.enterpriseUsage)
  });
};

module.exports = { metricsMiddleware, getMetrics };