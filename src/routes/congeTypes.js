const express = require('express');
const router = express.Router();

const authorizeRole = require('../middlewares/authorizeRole');
const validateUUIDParam = require('../middlewares/validateUUIDParam');
const congeTypesService = require('../services/congeTypesService');

function resolveEntrepriseId(req, { allowBody = false } = {}) {
  if (req.user?.role === 'super_admin') {
    if (req.query?.entreprise_id) return req.query.entreprise_id;
    if (allowBody && req.body?.entreprise_id) return req.body.entreprise_id;
  }
  return req.user?.entreprise_id || null;
}

router.post('/', authorizeRole(['super_admin', 'admin_entreprise']), async (req, res, next) => {
  try {
    const entrepriseId = resolveEntrepriseId(req, { allowBody: true });
    const type = await congeTypesService.createType(entrepriseId, req.body);
    res.status(201).json(type);
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const entrepriseId = resolveEntrepriseId(req);
    const types = await congeTypesService.listTypes(entrepriseId);
    res.json(types);
  } catch (err) { next(err); }
});

router.get('/:id', validateUUIDParam('id'), async (req, res, next) => {
  try {
    const entrepriseId = resolveEntrepriseId(req);
    const type = await congeTypesService.getTypeById(req.params.id, entrepriseId);
    res.json(type);
  } catch (err) { next(err); }
});

router.put('/:id', authorizeRole(['super_admin', 'admin_entreprise']), validateUUIDParam('id'), async (req, res, next) => {
  try {
    const entrepriseId = resolveEntrepriseId(req, { allowBody: true });
    const type = await congeTypesService.updateType(req.params.id, entrepriseId, req.body);
    res.json(type);
  } catch (err) { next(err); }
});

router.delete('/:id', authorizeRole(['super_admin', 'admin_entreprise']), validateUUIDParam('id'), async (req, res, next) => {
  try {
    const entrepriseId = resolveEntrepriseId(req);
    await congeTypesService.deleteType(req.params.id, entrepriseId);
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
