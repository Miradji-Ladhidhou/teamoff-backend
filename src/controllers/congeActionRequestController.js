'use strict';

const svc = require('../services/congeActionRequestService');

async function submit(req, res, next) {
  try {
    const { type, commentaire, date_debut_demandee, date_fin_demandee, debut_demi_journee_demandee, fin_demi_journee_demandee } = req.body;
    const request = await svc.submitRequest({
      congeId: req.params.id,
      type,
      commentaire,
      date_debut_demandee,
      date_fin_demandee,
      debut_demi_journee_demandee,
      fin_demi_journee_demandee,
      user: req.user,
    });
    res.status(201).json(request);
  } catch (err) { next(err); }
}

async function list(req, res, next) {
  try {
    const { statut, page = 1, limit = 20 } = req.query;
    const result = await svc.listRequests({
      entrepriseId: req.user.entreprise_id,
      statut: statut || undefined,
      page: Number(page),
      limit: Number(limit),
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function getOne(req, res, next) {
  try {
    const request = await svc.getRequest(req.params.requestId, req.user.entreprise_id);
    res.json(request);
  } catch (err) { next(err); }
}

async function approve(req, res, next) {
  try {
    const request = await svc.approveRequest(req.params.requestId, {
      commentaire: req.body.commentaire,
      adminUser: req.user,
    });
    res.json(request);
  } catch (err) { next(err); }
}

async function reject(req, res, next) {
  try {
    const request = await svc.rejectRequest(req.params.requestId, {
      commentaire: req.body.commentaire,
      adminUser: req.user,
    });
    res.json(request);
  } catch (err) { next(err); }
}

module.exports = { submit, list, getOne, approve, reject };
