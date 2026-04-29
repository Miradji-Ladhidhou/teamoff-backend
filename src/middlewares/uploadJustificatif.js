// Middleware Multer pour upload de justificatifs d'absence
// Le fichier reste en mémoire (Buffer) — il est transmis en pièce jointe par email, jamais écrit sur disque.
const multer = require('multer');

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  // Accepte PDF, JPG, PNG
  if (["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype)) cb(null, true);
  else cb(new Error('Format de fichier non autorisé (PDF, JPG, PNG uniquement)'), false);
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

module.exports = upload;