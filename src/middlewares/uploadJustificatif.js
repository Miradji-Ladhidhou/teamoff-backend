// Middleware Multer pour upload de justificatifs d'absence
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Dossier de destination (à adapter si besoin)
const uploadDir = path.join(__dirname, '../../uploads/justificatifs');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}_${Math.round(Math.random()*1e6)}${ext}`;
    cb(null, name);
  }
});

const fileFilter = (req, file, cb) => {
  // Accepte PDF, JPG, PNG
  if (["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype)) cb(null, true);
  else cb(new Error('Format de fichier non autorisé (PDF, JPG, PNG uniquement)'), false);
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

module.exports = upload;