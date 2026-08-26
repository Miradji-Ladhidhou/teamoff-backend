'use strict';
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES  = 12;  // 96-bit IV recommandé pour GCM
const TAG_BYTES = 16;

/**
 * Dérive la clé depuis TOTP_ENCRYPTION_KEY (64 chars hex = 32 octets).
 * Lance une erreur explicite si la variable est absente ou malformée —
 * on préfère crasher au démarrage plutôt qu'écrire des secrets en clair.
 */
function getKey() {
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'TOTP_ENCRYPTION_KEY est manquante. ' +
      'Générez-la avec : node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('TOTP_ENCRYPTION_KEY doit être 64 caractères hexadécimaux (32 octets).');
  }
  return Buffer.from(raw, 'hex');
}

/**
 * Chiffre un secret TOTP (base32 plaintext).
 * Retourne une chaîne "<iv_hex>:<authTag_hex>:<ciphertext_hex>".
 */
function encryptTotpSecret(plaintextBase32) {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintextBase32, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * Déchiffre une valeur stockée en DB.
 * Accepte les deux formats :
 *   - "<iv>:<tag>:<ciphertext>" → chiffré (nouveau format)
 *   - toute autre valeur sans ':' → plaintext legacy, retourné tel quel
 *     (les secrets legacy seront migrés par le script de migration)
 */
function decryptTotpSecret(stored) {
  if (!stored) return null;

  // Legacy plaintext — pas encore migré
  if (!stored.includes(':')) return stored;

  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('Format totp_secret invalide : attendu iv:authTag:ciphertext');
  }

  const key       = getKey();
  const iv        = Buffer.from(parts[0], 'hex');
  const authTag   = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Indique si une valeur stockée est déjà chiffrée.
 */
function isEncrypted(stored) {
  return !!stored && stored.includes(':');
}

module.exports = { encryptTotpSecret, decryptTotpSecret, isEncrypted };
