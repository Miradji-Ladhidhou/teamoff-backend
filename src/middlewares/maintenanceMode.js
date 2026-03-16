const jwt = require('jsonwebtoken');
const systemSettingsService = require('../services/systemSettingsService');

const PUBLIC_WHITELIST = new Set([
  '/health',
  '/api/health',
  '/api/auth/login',
  '/api/auth/register',
]);

module.exports = async (req, res, next) => {
  try {
    if (PUBLIC_WHITELIST.has(req.path)) {
      return next();
    }

    const maintenanceStatus = await systemSettingsService.getMaintenanceStatus();
    if (!maintenanceStatus.enabled) {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded?.role === 'super_admin') {
          return next();
        }
      } catch (error) {
        // Ignore decode errors and continue to maintenance response.
      }
    }

    return res.status(503).json({
      error: 'MAINTENANCE_MODE',
      message: maintenanceStatus.message || 'Application en maintenance. Veuillez reessayer plus tard.',
    });
  } catch (error) {
    return next(error);
  }
};
