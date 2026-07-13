const congeService = require('../services/congesService');
const notificationService = require('../services/notificationSocketService');

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
    const { Conge, Utilisateur, Entreprise, CongeType, JoursFeries, CompteurConges } = require('../models');
    const dayjs = require('dayjs');

    const { id } = req.params;
    const reqUser = req.user;

    const conge = await Conge.findByPk(id, {
      include: [
        { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'email', 'service'] },
        { model: CongeType, as: 'conge_type', attributes: ['id', 'libelle'] },
        { model: Entreprise, as: 'entreprise', attributes: ['id', 'nom', 'parametres'] },
      ],
    });

    if (!conge) return res.status(404).json({ message: 'Congé introuvable' });

    // Employé : peut uniquement télécharger ses propres attestations
    if (reqUser.role === 'employe' && conge.utilisateur_id !== reqUser.id) {
      return res.status(403).json({ message: 'Accès interdit' });
    }
    // Seuls les congés valide_final peuvent faire l'objet d'une attestation
    if (conge.statut !== 'valide_final') {
      return res.status(400).json({ message: 'L\'attestation n\'est disponible que pour les congés approuvés' });
    }

    // Admin entreprise (employeur affiché dans l'attestation)
    const admin = await Utilisateur.findOne({
      where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise' },
      attributes: ['prenom', 'nom', 'email'],
    });

    // Détail des jours : compter dimanches, samedis, fériés dans la période
    const debut = dayjs(conge.date_debut);
    const fin = dayjs(conge.date_fin);

    const ferieRows = await JoursFeries.findAll({
      where: { entreprise_id: conge.entreprise_id },
      attributes: ['date', 'libelle'],
    });
    const feriesMap = new Map(ferieRows.map(f => [f.date.slice(0, 10), f.libelle]));

    let joursDansPeriode = 0;
    let dimanches = 0;
    let samedis = 0;
    let feriesExclus = 0;
    const feriesDetails = [];
    let current = debut;

    while (current.isBefore(fin, 'day') || current.isSame(fin, 'day')) {
      joursDansPeriode++;
      const dow = current.day(); // 0 = dimanche, 6 = samedi
      const key = current.format('YYYY-MM-DD');

      if (dow === 0) {
        dimanches++;
      } else if (dow === 6) {
        samedis++;
      } else if (feriesMap.has(key)) {
        feriesExclus++;
        feriesDetails.push({ date: key, libelle: feriesMap.get(key) });
      }
      current = current.add(1, 'day');
    }

    const joursOuvrables = Number(conge.jours_calcules) || 0;

    // Soldes
    const annee = debut.year();
    const compteur = await CompteurConges.findOne({
      where: { utilisateur_id: conge.utilisateur_id, conge_type_id: conge.conge_type_id, annee },
    });
    const joursAcquis = parseFloat(compteur?.jours_acquis || 0);
    const jours_reserves = parseFloat(compteur?.jours_reserves || 0);
    const soldeApres = Math.max(0, joursAcquis - jours_reserves);
    const soldeAvant = soldeApres + joursOuvrables;

    // Référence unique
    const reference = `ATT-${debut.format('YYYYMMDD')}-${id.slice(0, 4).toUpperCase()}`;

    const parametres = conge.entreprise?.parametres || {};

    res.json({
      reference,
      date: dayjs().format('DD MMMM YYYY'),
      ville: parametres.ville || '',
      employeur: {
        nom: admin ? `${admin.prenom || ''} ${admin.nom || ''}`.trim() : '',
        fonction: 'Administrateur',
        entreprise: conge.entreprise?.nom || '',
        adresse: parametres.adresse || '',
        email: admin?.email || '',
      },
      salarie: {
        nom: `${conge.utilisateur?.prenom || ''} ${conge.utilisateur?.nom || ''}`.trim(),
        poste: conge.utilisateur?.service || '',
      },
      conge: {
        debut: debut.locale('fr').format('D MMMM YYYY'),
        fin: fin.locale('fr').format('D MMMM YYYY'),
        jours_calendaires: joursDansPeriode,
        dimanches,
        samedis,
        jours_feries: feriesExclus,
        feries_details: feriesDetails,
        jours_ouvrables: joursOuvrables,
        solde_avant: soldeAvant,
        solde_apres: soldeApres,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { checkOverlap, checkValidationOverlap, create, list, get, update, remove, validate, reject, calculateDays, getAttestationData };
