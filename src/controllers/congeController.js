const congeService = require('../services/congesService');
const notificationService = require('../services/notificationSocketService');

async function checkOverlap(req, res) {
  try {
    const result = await congeService.checkOverlapConge({ ...req.body, reqUser: req.user });
    res.json(result);
  }
  catch(err) { res.status(400).json({ message: err.message }); }
}

async function checkValidationOverlap(req, res) {
  try {
    const result = await congeService.getValidationOverlapStatus(req.params.id, req.user);
    res.json(result);
  }
  catch(err) { res.status(400).json({ message: err.message }); }
}

async function create(req, res) {
  try {
    const conge = await congeService.createConge({ ...req.body, reqUser: req.user, req });

    // Notifier les administrateurs de l'entreprise
    notificationService.notifyCompany(req.user.entreprise_id, 'conge-created', {
      conge,
      user: req.user
    });

    res.status(201).json(conge);
  }
  catch(err) { res.status(400).json({ message: err.message }); }
}

async function list(req, res) {
  try { res.json(await congeService.getConges(req.user)); }
  catch(err) { res.status(500).json({ message: err.message }); }
}

async function get(req, res) {
  try { res.json(await congeService.getCongeById(req.params.id, req.user)); }
  catch(err) { res.status(404).json({ message: err.message }); }
}

async function update(req, res) {
  try { res.json(await congeService.updateConge(req.params.id, req.body, req.user, req)); }
  catch(err) { res.status(400).json({ message: err.message }); }
}

async function remove(req, res) {
  try {
    const commentaire = req.body?.commentaire ?? null;
    await congeService.deleteConge(req.params.id, req.user, { commentaire, req });

    // Notifier les administrateurs
    notificationService.notifyCompany(req.user.entreprise_id, 'conge-deleted', {
      congeId: req.params.id,
      user: req.user
    });

    res.status(204).send();
  }
  catch(err) { res.status(400).json({ message: err.message }); }
}

async function validate(req, res) {
  try {
    const commentaire = req.body?.commentaire ?? null;
    const conge = await congeService.validerConge(req.params.id, req.user, commentaire, req);

    // Notifier l'utilisateur qui a fait la demande
    notificationService.notifyUser(conge.utilisateur_id, 'conge-validated', {
      conge,
      validatedBy: req.user,
      commentaire
    });

    // Notifier tous les administrateurs de l'entreprise
    notificationService.notifyCompany(req.user.entreprise_id, 'conge-status-changed', {
      conge,
      action: 'validated',
      by: req.user
    });

    res.json(conge);
  }
  catch(err) { res.status(400).json({ message: err.message }); }
}

async function reject(req, res) {
  try {
    const commentaire = req.body?.commentaire ?? null;
    const conge = await congeService.rejeterConge(req.params.id, req.user, commentaire, req);

    // Notifier l'utilisateur qui a fait la demande
    notificationService.notifyUser(conge.utilisateur_id, 'conge-rejected', {
      conge,
      rejectedBy: req.user,
      commentaire
    });

    // Notifier tous les administrateurs de l'entreprise
    notificationService.notifyCompany(req.user.entreprise_id, 'conge-status-changed', {
      conge,
      action: 'rejected',
      by: req.user
    });

    res.json(conge);
  }
  catch(err) { res.status(400).json({ message: err.message }); }
}

module.exports = { checkOverlap, checkValidationOverlap, create, list, get, update, remove, validate, reject };