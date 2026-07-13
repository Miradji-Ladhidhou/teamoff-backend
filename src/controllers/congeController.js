const congeService = require('../services/congesService');
const notificationService = require('../services/notificationSocketService');
const joursFeriesService = require('../services/joursFeriesService');
const { getLeaveRules } = require('../services/politiqueConges');
const { Conge, Utilisateur, CongeType, Entreprise } = require('../models');
const dayjs = require('dayjs');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
dayjs.extend(isSameOrBefore);

const DAY_LABELS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

function findJourFerie(dateStr, joursFeries) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return joursFeries.find(jf => {
    if (jf.est_travail) return false;
    const jfDate = new Date(jf.date);
    if (jf.recurrent) return jfDate.getUTCDate() === d && jfDate.getUTCMonth() === (m - 1);
    return jfDate.toISOString().slice(0, 10) === dateStr;
  });
}

async function checkOverlap(req, res, next) {
  try {
    const result = await congeService.checkOverlapConge({ ...req.body, reqUser: req.user });
    res.json(result);
  }
  catch(err) { next(err); }
}

async function checkValidationOverlap(req, res, next) {
  try {
    const result = await congeService.getValidationOverlapStatus(req.params.id, req.user);
    res.json(result);
  }
  catch(err) { next(err); }
}

async function create(req, res, next) {
  try {
    const conge = await congeService.createConge({ ...req.body, reqUser: req.user, req });
    notificationService.notifyCompany(req.user.entreprise_id, 'conge-created', { conge, user: req.user });
    res.status(201).json(conge);
  }
  catch(err) { next(err); }
}

async function list(req, res, next) {
  try {
    const { items, total } = await congeService.getConges(req.user, req.query);
    res.json({ items, total });
  }
  catch(err) { next(err); }
}

async function get(req, res, next) {
  try {
    const conge = await congeService.getCongeById(req.params.id, req.user);
    if (!conge) return res.status(404).json({ message: 'Congé introuvable' });
    res.json(conge);
  }
  catch(err) { next(err); }
}

async function update(req, res, next) {
  try { res.json(await congeService.updateConge(req.params.id, req.body, req.user, req)); }
  catch(err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const commentaire = req.body?.commentaire ?? null;
    await congeService.deleteConge(req.params.id, req.user, { commentaire, req });
    notificationService.notifyCompany(req.user.entreprise_id, 'conge-deleted', { congeId: req.params.id, user: req.user });
    res.status(204).send();
  }
  catch(err) { next(err); }
}

async function validate(req, res, next) {
  try {
    const commentaire = req.body?.commentaire ?? null;
    const conge = await congeService.validerConge(req.params.id, req.user, commentaire, req);
    notificationService.notifyUser(conge.utilisateur_id, 'conge-validated', { conge, validatedBy: req.user, commentaire });
    notificationService.notifyCompany(req.user.entreprise_id, 'conge-status-changed', { conge, action: 'validated', by: req.user });
    res.json(conge);
  }
  catch(err) { next(err); }
}

async function reject(req, res, next) {
  try {
    const commentaire = req.body?.commentaire ?? null;
    const conge = await congeService.rejeterConge(req.params.id, req.user, commentaire, req);
    notificationService.notifyUser(conge.utilisateur_id, 'conge-rejected', { conge, rejectedBy: req.user, commentaire });
    notificationService.notifyCompany(req.user.entreprise_id, 'conge-status-changed', { conge, action: 'rejected', by: req.user });
    res.json(conge);
  }
  catch(err) { next(err); }
}

async function calculateDays(req, res, next) {
  try {
    const result = await congeService.calculateDaysPreview(req.body, req.user);
    res.json(result);
  }
  catch(err) { next(err); }
}

async function getAttestationData(req, res, next) {
  try {
    const conge = await Conge.findByPk(req.params.id, {
      include: [
        { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'email', 'service', 'date_embauche'] },
        { model: CongeType,   as: 'conge_type',  attributes: ['libelle'] },
        { model: Entreprise,  as: 'entreprise',  attributes: ['nom', 'politique_conges'] },
      ],
    });

    if (!conge) return res.status(404).json({ message: 'Congé introuvable' });

    const user = req.user;
    if (user.role !== 'super_admin' && user.entreprise_id !== conge.entreprise_id && user.id !== conge.utilisateur_id)
      return res.status(403).json({ message: 'Accès interdit' });

    const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(conge.entreprise_id);
    const leaveRules = getLeaveRules(conge.entreprise);
    const { count_saturday, count_sunday } = leaveRules.blocked_days || {};

    const start = dayjs(conge.date_debut);
    const end = dayjs(conge.date_fin);
    const jours_calendaires = end.diff(start, 'day') + 1;

    const detail = [];
    for (let d = start; d.isSameOrBefore(end, 'day'); d = d.add(1, 'day')) {
      const dow = d.day();
      const dateStr = d.format('YYYY-MM-DD');

      if (dow === 0) {
        detail.push({ date: dateStr, type: 'weekend', label: 'Dimanche', inclus: count_sunday === true });
      } else if (dow === 6) {
        detail.push({ date: dateStr, type: 'weekend', label: 'Samedi', inclus: count_saturday === true });
      } else {
        const jf = findJourFerie(dateStr, joursFeries);
        if (jf) detail.push({ date: dateStr, type: 'ferie', label: jf.libelle, inclus: false });
      }
    }

    res.json({
      reference: `ATT-${dayjs(conge.date_debut).year()}-${String(conge.id).substring(0, 6).toUpperCase()}`,
      genere_le: dayjs().format('DD/MM/YYYY'),
      entreprise: {
        nom: conge.entreprise?.nom || '',
      },
      employe: {
        nom: conge.utilisateur?.nom || '',
        prenom: conge.utilisateur?.prenom || '',
        email: conge.utilisateur?.email || '',
        service: conge.utilisateur?.service || '',
        date_embauche: conge.utilisateur?.date_embauche || null,
      },
      conge: {
        type: conge.conge_type?.libelle || '',
        date_debut: conge.date_debut,
        date_fin: conge.date_fin,
        debut_demi_journee: conge.debut_demi_journee || null,
        fin_demi_journee: conge.fin_demi_journee || null,
        statut: conge.statut,
        commentaire_employe: conge.commentaire_employe || '',
        commentaire_manager: conge.commentaire_manager || '',
        commentaire_admin: conge.commentaire_admin || '',
      },
      jours: {
        calendaires: jours_calendaires,
        ouvres: parseFloat(conge.jours_calcules) || 0,
        detail,
      },
    });
  }
  catch(err) { next(err); }
}

module.exports = { checkOverlap, checkValidationOverlap, create, list, get, update, remove, validate, reject, calculateDays, getAttestationData };
