'use strict';

const iconv = require('iconv-lite');

/**
 * Décode un buffer CSV en string UTF-8 quel que soit l'encodage source.
 *
 * Ordre de détection :
 *  1. UTF-16 LE + BOM (FF FE)  — Excel "Enregistrer sous → CSV UTF-16"
 *  2. UTF-16 BE + BOM (FE FF)  — rare mais possible
 *  3. UTF-8  + BOM (EF BB BF)  — Excel moderne "CSV UTF-8 (avec BOM)"
 *  4. UTF-8  sans BOM           — Google Sheets, LibreOffice, éditeurs modernes
 *  5. Windows-1252 (Latin-1)   — Excel français par défaut sur Windows
 *     (détecté par la présence du caractère de remplacement U+FFFD après
 *      tentative UTF-8)
 *
 * @param {Buffer} buffer
 * @returns {string} contenu en UTF-8
 */
function decodeCsvBuffer(buffer) {
  // — UTF-16 LE (FF FE) —
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return iconv.decode(buffer.slice(2), 'utf-16le');
  }

  // — UTF-16 BE (FE FF) —
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return iconv.decode(buffer.slice(2), 'utf-16be');
  }

  // — UTF-8 BOM (EF BB BF) —
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.slice(3).toString('utf8');
  }

  // — Tente UTF-8 : si aucun caractère de remplacement, c'est bon —
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) {
    return utf8;
  }

  // — Fallback Windows-1252 (Excel français par défaut) —
  return iconv.decode(buffer, 'windows-1252');
}

module.exports = { decodeCsvBuffer };
