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
  'client_secret',
  'clientsecret',
  'smtppassword',
  'slackwebhook',
]);

function sanitizeMessage(value) {
  let text = String(value);
  // Also mask unlabelled secrets known to this process, including URL credentials.
  const secrets = new Set();
  for (const [key, val] of Object.entries(process.env)) {
    if (val && /password|(?:^|_)pass(?:$|_)|secret|token|api_?key|private_?key|webhook/i.test(key)) {
      secrets.add(val);
      secrets.add(encodeURIComponent(val));
    }
    if (val && /(?:database_url|pgurl)$/i.test(key)) {
      secrets.add(val);
      try {
        const url = new URL(val);
        if (url.password) {
          secrets.add(url.password);
          secrets.add(decodeURIComponent(url.password));
        }
      } catch { /* Non-URL configuration is still masked as a whole. */ }
    }
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join(REDACTED);
  }
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, REDACTED)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@[^\s/]*/gi, `$1${REDACTED}`)
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, `$1 ${REDACTED}`)
    .replace(/((?:set-cookie|cookies?)\s*[:=]\s*)([^\r\n]+)/gi, `$1${REDACTED}`)
    .replace(/((?:["']?(?:[\w.-]*(?:password|secret|token|api_?key|authorization|cookie|webhook)[\w.-]*)["']?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi, `$1${REDACTED}`);
}

function sanitizeError(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return error;
  seen.add(error);
  for (const field of ['message', 'stack', 'stderr', 'stdout', 'cmd']) {
    if (error[field] != null) error[field] = sanitizeMessage(error[field]);
  }
  sanitizeError(error.cause, seen);
  sanitizeError(error.cleanupError, seen);
  for (const field of ['errors', 'cleanupErrors']) {
    if (Array.isArray(error[field])) {
      for (const child of error[field]) sanitizeError(child, seen);
    }
  }
  return error;
}

function sanitizeLogData(obj, depth = 0) {
  if (typeof obj === 'string') return sanitizeMessage(obj);
  if (obj === null || typeof obj !== 'object') return obj;
  if (depth > 4) return REDACTED;
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
module.exports.sanitizeMessage = sanitizeMessage;
module.exports.sanitizeError = sanitizeError;
