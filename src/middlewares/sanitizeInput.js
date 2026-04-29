'use strict';
const sanitizeHtml = require('sanitize-html');

const OPTS = { allowedTags: [], allowedAttributes: {} };

function sanitizeValue(val) {
  if (typeof val === 'string') return sanitizeHtml(val, OPTS);
  if (Array.isArray(val)) return val.map(sanitizeValue);
  if (val !== null && typeof val === 'object') {
    return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, sanitizeValue(v)]));
  }
  return val;
}

/**
 * Strips all HTML tags from every string in req.body and req.query recursively.
 * req.params intentionally excluded — UUIDs are validated by validateUUIDParam.
 * Applied globally after express.json() — defense-in-depth before validators.
 */
function sanitizeInput(req, res, next) {
  if (req.body && typeof req.body === 'object') req.body = sanitizeValue(req.body);
  if (req.query && typeof req.query === 'object') {
    // req.query est un getter en Express 5 — mutation en place obligatoire
    const sanitized = sanitizeValue(req.query);
    Object.assign(req.query, sanitized);
  }
  next();
}

module.exports = sanitizeInput;
