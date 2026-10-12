// Middleware Multer pour upload de justificatifs d'absence
// Le fichier reste en mémoire tampon (RAM / Buffer) — il est transmis en pièce jointe par email, jamais écrit sur disque ni conservé en base.
const multer = require('multer');

const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
];

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error('Format de fichier non autorisé (PDF, JPG, PNG ou WEBP uniquement).'), { status: 400 }), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 Mo max
});

function handleUploadJustificatif(req, res, next) {
  upload.single('justificatif')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'Le justificatif est trop volumineux (maximum 10 Mo).' });
      }
      return res.status(err.status || 400).json({ message: err.message || 'Erreur lors du téléversement du justificatif.' });
    }
    next();
  });
}

module.exports = {
  upload,
  handleUploadJustificatif,
};