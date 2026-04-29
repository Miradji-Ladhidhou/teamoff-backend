const { CongeType } = require('../models');
const { AppError } = require('../utils/errors');

async function listTypes(entrepriseId) {
  if (!entrepriseId) throw new AppError('entreprise_id est requis', 400);
  return CongeType.findAll({ where: { entreprise_id: entrepriseId } });
}

async function getTypeById(id, entrepriseId) {
  if (!entrepriseId) throw new AppError('entreprise_id est requis', 400);
  const type = await CongeType.findOne({ where: { id, entreprise_id: entrepriseId } });
  if (!type) throw new AppError('Type introuvable', 404);
  return type;
}

async function createType(entrepriseId, { code, libelle, quota_annuel, demi_journee_autorisee }) {
  if (!entrepriseId) throw new AppError('entreprise_id est requis', 400);
  if (!code || typeof code !== 'string' || !code.trim()) throw new AppError('Le champ code est requis', 400);
  if (!libelle || typeof libelle !== 'string' || !libelle.trim()) throw new AppError('Le champ libelle est requis', 400);
  if (quota_annuel !== undefined && (isNaN(Number(quota_annuel)) || Number(quota_annuel) < 0)) {
    throw new AppError('quota_annuel doit être un nombre positif', 400);
  }

  return CongeType.create({
    entreprise_id: entrepriseId,
    code: code.trim().toUpperCase(),
    libelle: libelle.trim(),
    quota_annuel: quota_annuel != null ? Number(quota_annuel) : null,
    demi_journee_autorisee: Boolean(demi_journee_autorisee),
  });
}

async function updateType(id, entrepriseId, body) {
  const type = await getTypeById(id, entrepriseId);
  const allowed = ['code', 'libelle', 'quota_annuel', 'demi_journee_autorisee'];
  const updates = {};
  for (const field of allowed) {
    if (field in body) updates[field] = body[field];
  }
  await type.update(updates);
  return type;
}

async function deleteType(id, entrepriseId) {
  const type = await getTypeById(id, entrepriseId);
  await type.destroy();
}

module.exports = { listTypes, getTypeById, createType, updateType, deleteType };
