'use strict';

const REDACTED = '***';

// Clés dont la valeur est masquée dans les logs (comparaison insensible à la casse)
const SENSITIVE = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'newpassword',
  'currentpassword',
  'refreshtoken',
  'refresh_token',
  'token',
  'accesstoken',
  'access_token',
  'authorization',
  'cookie',
  'cookies',
  'secret',
  'apikey',
  'api_key',
  'private_key',
  'privatekey',
]);

function sanitizeLogData(obj, depth = 0) {
  if (depth > 4 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => sanitizeLogData(v, depth + 1));

  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = SENSITIVE.has(key.toLowerCase()) && val != null
      ? REDACTED
      : sanitizeLogData(val, depth + 1);
  }
  return result;
}

module.exports = sanitizeLogData;
