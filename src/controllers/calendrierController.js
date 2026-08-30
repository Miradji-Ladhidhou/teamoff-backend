const { Conge, CongeType, Utilisateur, Absence } = require('../models');
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const dayjs = require('dayjs');

/**
 * Retourne les congés ET les absences visibles selon le rôle de l'utilisateur.
 * Compatible avec :
 *  - GET /calendrier-conges            → tous les événements de l'entreprise
 *  - GET /calendrier-conges/:year/:month → événements qui chevauchent le mois donné
 *
 * Query params optionnels :
 *  - entrepriseId : UUID  (super_admin seulement)
 *  - statut       : ex. 'valide_final'  (filtre congés uniquement)
 *  - utilisateurId: UUID
 *
 * Chaque item porte record_type: 'conge' | 'absence'.
 * Le frontend scinde le tableau par record_type pour peupler ses deux états séparés.
 *
 * Les absences passent par ce endpoint plutôt que par /absences pour que les
 * employés voient les absences de leurs collègues sur le calendrier (besoin métier),
 * avec le masquage RGPD Art. 9 appliqué ici pour les arrêts maladie.
 * L'endpoint /absences reste lui restreint aux propres absences de l'employé (C-1).
 */
async function getCalendrier(req, res, next) {
  try {
    const { year, month } = req.params;
    const { entrepriseId, statut, utilisateurId } = req.query;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (entrepriseId && !UUID_RE.test(entrepriseId))
      return res.status(400).json({ message: 'entrepriseId invalide' });
    if (utilisateurId && utilisateurId !== 'all' && !UUID_RE.test(utilisateurId))
      return res.status(400).json({ message: 'utilisateurId invalide' });

    // ─── filtrage par entreprise ─────────────────────────────────────────────
    let targetEntrepriseId;
    if (req.user.role === 'super_admin') {
      targetEntrepriseId = entrepriseId || null;
    } else {
      targetEntrepriseId = req.user.entreprise_id;
    }

    // ─── fenêtre temporelle ──────────────────────────────────────────────────
    let dateFilter = null;
    if (year || month) {
      const y = Number(year);
      const m = Number(month);
      if (!Number.isInteger(y) || y < 2000 || y > 2100) {
        return res.status(400).json({ message: 'Paramètre year invalide (attendu : entier entre 2000 et 2100)' });
      }
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        return res.status(400).json({ message: 'Paramètre month invalide (attendu : entier entre 1 et 12)' });
      }
      const firstDay = dayjs(`${y}-${String(m).padStart(2, '0')}-01`).startOf('month').toDate();
      const lastDay  = dayjs(`${y}-${String(m).padStart(2, '0')}-01`).endOf('month').toDate();
      dateFilter = { firstDay, lastDay };
    }

    const isEmployee = ['employe', 'apprenti'].includes(req.user.role);
    const canFilterByUser = ['super_admin', 'admin_entreprise', 'manager'].includes(req.user.role);

    // ═════════════════════════════════════════════════════════════════════════
    // 1. CONGÉS
    // ═════════════════════════════════════════════════════════════════════════
    const congeWhere = {};
    if (targetEntrepriseId) congeWhere.entreprise_id = targetEntrepriseId;

    const VALID_STATUTS = ['reserve', 'en_attente_manager', 'valide_manager', 'refuse_manager', 'valide_final', 'refuse_final'];
    if (statut && statut !== 'all') {
      if (!VALID_STATUTS.includes(statut)) return res.json([]);
      congeWhere.statut = statut;
    }

    if (canFilterByUser && utilisateurId && utilisateurId !== 'all') {
      congeWhere.utilisateur_id = utilisateurId;
    }

    if (isEmployee) {
      congeWhere[Op.or] = [
        { utilisateur_id: req.user.id },
        { statut: { [Op.notIn]: ['refuse_manager', 'refuse_final'] } },
      ];
    }

    if (dateFilter) {
      congeWhere.date_debut = { [Op.lte]: dateFilter.lastDay };
      congeWhere.date_fin   = { [Op.gte]: dateFilter.firstDay };
    }

    const conges = await Conge.findAll({
      where: congeWhere,
      include: [
        { model: CongeType, as: 'conge_type', attributes: ['id', 'code', 'libelle'] },
        { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'nom', 'prenom', 'service', 'email'] },
      ],
      order: [['date_debut', 'ASC']],
    });

    let congesResult;
    if (isEmployee) {
      congesResult = conges.map(c => {
        const plain = c.toJSON();
        plain.record_type = 'conge';
        if (c.utilisateur_id === req.user.id) return plain;
        plain.commentaire_employe = null;
        plain.commentaire_manager = null;
        plain.commentaire_admin   = null;
        return plain;
      });
    } else {
      congesResult = conges.map(c => ({ ...c.toJSON(), record_type: 'conge' }));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 2. ABSENCES — tout le monde voit les absences de l'entreprise via le
    //    calendrier (besoin métier : savoir qui est absent pour se coordonner).
    //    RGPD Art. 9 : type maladie + commentaire masqués pour les collègues.
    // ═════════════════════════════════════════════════════════════════════════
    const absenceWhere = {};
    if (targetEntrepriseId) absenceWhere.entreprise_id = targetEntrepriseId;

    if (canFilterByUser && utilisateurId && utilisateurId !== 'all') {
      absenceWhere.utilisateur_id = utilisateurId;
    }

    if (dateFilter) {
      absenceWhere.date_debut = { [Op.lte]: dateFilter.lastDay };
      absenceWhere.date_fin   = { [Op.gte]: dateFilter.firstDay };
    }

    const absences = await Absence.findAll({
      where: absenceWhere,
      include: [
        { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'nom', 'prenom', 'service', 'email'] },
      ],
      order: [['date_debut', 'ASC']],
    });

    const absencesResult = absences.map(a => {
      const plain = a.toJSON();
      plain.record_type = 'absence';
      if (isEmployee && a.utilisateur_id !== req.user.id && a.type_absence === 'maladie') {
        plain.type_absence = 'confidentiel';
        plain.commentaire  = null;
      }
      return plain;
    });

    // ─── Résultat fusionné ────────────────────────────────────────────────────
    const result = [...congesResult, ...absencesResult].sort((a, b) =>
      a.date_debut < b.date_debut ? -1 : a.date_debut > b.date_debut ? 1 : 0
    );

    res.json(result);
  } catch (err) {
    logger.error(err);
    next(err);
  }
}

module.exports = { getCalendrier };
