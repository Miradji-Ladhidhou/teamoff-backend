'use strict';
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES  = 12;

/**
 * Clé AES-256-GCM dérivée de SETTINGS_ENCRYPTION_KEY (64 chars hex = 32 octets).
 * Séparée de TOTP_ENCRYPTION_KEY pour permettre une rotation indépendante.
 */
function getKey() {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'SETTINGS_ENCRYPTION_KEY est manquante. ' +
      'Générez-la avec : node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('SETTINGS_ENCRYPTION_KEY doit être 64 caractères hexadécimaux (32 octets).');
  }
  return Buffer.from(raw, 'hex');
}

/**
 * Chiffre une valeur de paramètre sensible.
 * Format stocké : "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 */
function encryptSecret(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  const iv  = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * Déchiffre une valeur stockée.
 * - Format "iv:tag:ct" → déchiffre avec AES-256-GCM
 * - Toute autre valeur (legacy plaintext) → retournée telle quelle
 */
function decryptSecret(stored) {
  if (!stored) return stored;
  if (!isEncrypted(stored)) return stored; // legacy plaintext — pas encore migré
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('Format chiffré invalide : attendu iv:authTag:ciphertext');
  const key       = getKey();
  const iv        = Buffer.from(parts[0], 'hex');
  const authTag   = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');
  const decipher  = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function isEncrypted(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  // iv (24 hex) + authTag (32 hex) + ciphertext (≥2 hex)
  return parts.length === 3 && parts[0].length === 24 && parts[1].length === 32;
}

module.exports = { encryptSecret, decryptSecret, isEncrypted };
