'use strict';
const logger = require('../utils/logger');

/**
 * Structured HTTP access log — userId, ip, method, path, status, latency.
 * Runs on res 'finish' so req.user is fully populated by auth middleware.
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path === '/health') return;
    const status = res.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger[level]('http_request', {
      requestId:  req.id ?? null,
      method:     req.method,
      path:       req.path,
      status,
      durationMs: Date.now() - start,
      ip:         req.ip,
      userId:     req.user?.id ?? null,
      userAgent:  req.headers['user-agent'] ?? null,
    });
  });
  next();
}

module.exports = requestLogger;
