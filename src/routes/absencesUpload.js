// Route d’upload de justificatif pour Absence (utilisée par le frontend)
const express = require('express');
const router = express.Router();
const upload = require('../middlewares/uploadJustificatif');
const path = require('path');

/**
 * POST /api/absences/upload
 * Upload d’un justificatif (PDF/JPG/PNG)
 * Retourne l’URL du fichier uploadé
 */
router.post('/', upload.single('justificatif'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Aucun fichier reçu' });
  // URL relative pour stockage local
  const url = `/uploads/justificatifs/${req.file.filename}`;
  res.status(201).json({ url });
});

module.exports = router;
