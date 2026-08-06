const congeService = require('../services/congesService');
const notificationService = require('../services/notificationSocketService');
const joursFeriesService = require('../services/joursFeriesService');
const { getLeaveRules } = require('../services/politiqueConges');
const emailService = require('../services/emailService');
const { Conge, Utilisateur, CongeType, Entreprise, CompteurConges } = require('../models');
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

    const anneeConge = dayjs(conge.date_debut).year();
    const compteur = await CompteurConges.findOne({
      where: { utilisateur_id: conge.utilisateur_id, conge_type_id: conge.conge_type_id, annee: anneeConge },
    });
    const acquis   = parseFloat(compteur?.jours_acquis   ?? 0);
    const pris     = parseFloat(compteur?.jours_pris     ?? 0);
    const reserves = parseFloat(compteur?.jours_reserves ?? 0);
    const soldeRestant = acquis - pris - reserves;

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
        date_creation: conge.created_at || null,
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
        politique: {
          count_saturday: count_saturday === true,
          count_sunday: count_sunday === true,
        },
      },
      solde: compteur ? {
        annee: anneeConge,
        type: conge.conge_type?.libelle || '',
        jours_acquis: acquis,
        jours_pris: pris,
        jours_reserves: reserves,
        solde_restant: soldeRestant,
      } : null,
    });
  }
  catch(err) { next(err); }
}

const STATUT_LABELS_EMAIL = {
  valide_final: 'Validé',
  valide_manager: 'Validé (manager)',
  en_attente_manager: 'En attente',
  refuse_manager: 'Refusé (manager)',
  refuse_final: 'Refusé',
};

async function sendAttestationEmail(req, res, next) {
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

    const recipientEmail = conge.utilisateur?.email;
    if (!recipientEmail) return res.status(400).json({ message: 'Adresse email de l\'employé introuvable' });

    const fmtDate = (d) => {
      if (!d) return '—';
      const [y, m, day] = String(d).split('T')[0].split('-');
      return `${day}-${m}-${y}`;
    };

    const fmtEmbauche = (d) => {
      if (!d) return null;
      const dt = new Date(String(d).split('T')[0] + 'T00:00:00');
      if (isNaN(dt)) return null;
      return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
    };

    const reference = `ATT-${dayjs(conge.date_debut).year()}-${String(conge.id).substring(0, 6).toUpperCase()}`;
    const genere_le = dayjs().format('DD/MM/YYYY');
    const employe = conge.utilisateur;
    const embaucheLabel = fmtEmbauche(employe?.date_embauche);

    // Calcul du décompte des jours (même logique que getAttestationData)
    const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(conge.entreprise_id);
    const leaveRules = getLeaveRules(conge.entreprise);
    const { count_saturday, count_sunday } = leaveRules.blocked_days || {};
    const start = dayjs(conge.date_debut);
    const end = dayjs(conge.date_fin);
    const jours_calendaires = end.diff(start, 'day') + 1;
    const jours_ouvres = parseFloat(conge.jours_calcules) || 0;
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

    // period label (avec demi-journée si applicable)
    const DEMI_LABELS_EMAIL = { matin: 'matin', apres_midi: 'après-midi' };
    const periodStart = conge.debut_demi_journee
      ? `${fmtDate(conge.date_debut)} (${DEMI_LABELS_EMAIL[conge.debut_demi_journee] || conge.debut_demi_journee})`
      : fmtDate(conge.date_debut);
    const periodEnd = conge.fin_demi_journee
      ? `${fmtDate(conge.date_fin)} (${DEMI_LABELS_EMAIL[conge.fin_demi_journee] || conge.fin_demi_journee})`
      : fmtDate(conge.date_fin);
    const period_label = `${periodStart} → ${periodEnd}`;

    // Décompte des jours (table-based, inline styles)
    const decompteRows = (() => {
      const rows = [];
      rows.push(`<table width="100%" cellspacing="0" cellpadding="0"><tr><td style="font-size:12px;color:#4a6080;font-family:Arial,sans-serif;padding:3px 0;border-bottom:1px solid rgba(37,99,235,0.1);">Jours calendaires</td><td align="right" style="font-size:12px;font-weight:700;color:#1e3a5f;font-family:Arial,sans-serif;padding:3px 0;border-bottom:1px solid rgba(37,99,235,0.1);white-space:nowrap;">${jours_calendaires} j</td></tr>`);

      const weekends = detail.filter(d => d.type === 'weekend');
      if (weekends.length > 0) {
        rows.push(`<tr><td colspan="2" style="padding-top:4px;padding-bottom:2px;font-size:10px;font-weight:700;color:#4a6080;text-transform:uppercase;letter-spacing:0.8px;font-family:Arial,sans-serif;">Week-ends</td></tr>`);
        weekends.forEach(d => {
          const badge = d.inclus
            ? `<span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:10px;background:#dcfce7;color:#15803d;">inclus</span>`
            : `<span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:10px;background:#fee2e2;color:#b91c1c;">exclu</span>`;
          rows.push(`<tr><td style="padding:1px 0 1px 6px;font-size:10px;color:#4a6080;font-family:Arial,sans-serif;">${d.label} ${fmtDate(d.date)}</td><td align="right" style="padding:1px 0;">${badge}</td></tr>`);
        });
      }

      const feries = detail.filter(d => d.type === 'ferie');
      rows.push(`<tr><td colspan="2" style="padding-top:4px;padding-bottom:2px;font-size:10px;font-weight:700;color:#4a6080;text-transform:uppercase;letter-spacing:0.8px;font-family:Arial,sans-serif;">Jours fériés</td></tr>`);
      if (feries.length === 0) {
        rows.push(`<tr><td colspan="2" style="padding:1px 0 1px 6px;font-size:10px;color:#94a3b8;font-family:Arial,sans-serif;font-style:italic;">Aucun jour férié sur la période</td></tr>`);
      } else {
        feries.forEach(d => {
          rows.push(`<tr><td style="padding:1px 0 1px 6px;font-size:10px;color:#4a6080;font-family:Arial,sans-serif;">${d.label} — ${fmtDate(d.date)}</td><td align="right" style="padding:1px 0;"><span style="font-size:10px;font-weight:700;padding:1px 5px;border-radius:10px;background:#fee2e2;color:#b91c1c;">exclu</span></td></tr>`);
        });
      }

      rows.push(`<tr><td colspan="2" style="padding-top:4px;border-top:2px solid #2563eb;"></td></tr>`);
      rows.push(`<tr><td style="font-size:12px;font-weight:700;color:#1e3a5f;font-family:Arial,sans-serif;padding:3px 0;">= Jours de congé accordés</td><td align="right" style="font-size:14px;font-weight:700;color:#2563eb;font-family:Arial,sans-serif;padding:3px 0;white-space:nowrap;">${jours_ouvres} j</td></tr>`);
      rows.push(`</table>`);
      return rows.join('');
    })();

    // Commentaires (table-based, inline styles)
    const commentsRows = (() => {
      const parts = [];
      if (conge.commentaire_employe) parts.push({ label: 'Employé', text: conge.commentaire_employe });
      if (conge.commentaire_manager) parts.push({ label: 'Manager', text: conge.commentaire_manager });
      if (conge.commentaire_admin)   parts.push({ label: 'Administration', text: conge.commentaire_admin });
      if (parts.length === 0) return `<div style="font-size:12px;color:#a0aec0;font-family:Arial,sans-serif;font-style:italic;">Aucun commentaire.</div>`;
      return parts.map(c => `<div style="margin-bottom:5px;"><div style="font-size:10px;color:#a16207;font-family:Arial,sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:1px;">${c.label}</div><div style="font-size:12px;color:#3b2e00;font-family:Arial,sans-serif;font-style:italic;line-height:1.35;">« ${c.text} »</div></div>`).join('');
    })();

    const nom_complet = `${employe?.prenom || ''} ${employe?.nom || ''}`.trim();

    const employe_context = [
      employe?.service ? `, employé(e) au sein du service <strong style="color:#1e3a5f;font-weight:700;">${employe.service}</strong>` : '',
      embaucheLabel ? `, en poste depuis le <strong style="color:#1e3a5f;font-weight:700;">${embaucheLabel}</strong>` : '',
    ].join('');

    const statut_color = conge.statut === 'valide_final' ? '#15803d' : '#1a2b40';

    const templateData = {
      entreprise_nom: conge.entreprise?.nom || '',
      reference,
      genere_le,
      nom_complet,
      employe_email: employe?.email || '',
      employe_service_ou_tiret: employe?.service || '—',
      employe_embauche_ou_tiret: embaucheLabel || '—',
      employe_context,
      conge_type: conge.conge_type?.libelle || '',
      date_debut: fmtDate(conge.date_debut),
      date_fin: fmtDate(conge.date_fin),
      period_label,
      jours_ouvres,
      statut_label: STATUT_LABELS_EMAIL[conge.statut] || conge.statut,
      statut_color,
      comments_rows: commentsRows,
      decompte_rows: decompteRows,
      year: dayjs().year(),
    };

    await emailService.sendEmail(
      recipientEmail,
      `Attestation de congé – ${reference}`,
      'attestation',
      templateData
    );

    res.json({ message: 'Attestation envoyée par email avec succès', email: recipientEmail });
  }
  catch(err) { next(err); }
}

async function activate(req, res, next) {
  try {
    const conge = await congeService.activerReservation(req.params.id, req.user);
    res.json(conge);
  }
  catch(err) { next(err); }
}

module.exports = { checkOverlap, checkValidationOverlap, create, list, get, update, remove, validate, reject, activate, calculateDays, getAttestationData, sendAttestationEmail };
