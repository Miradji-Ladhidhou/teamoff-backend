const { Op } = require('sequelize');
const { Utilisateur, CompteurConges, CongeType, Conge } = require('../models');
const { getPolitiqueType } = require('../services/politiqueConges');
const joursFeriesService = require('../services/joursFeriesService');
const { validateConge } = require('../utils/validate');
const { peutPoser, calculerSolde } = require('../services/congesService');
const { auditConge } = require('../services/auditHelper');
const { auditActions } = require('../services/auditActions');


/* Helper pour calcul jours congés */
async function calcJoursConges(entrepriseId, dateDebut, dateFin, debut_demi, fin_demi) {
  const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(entrepriseId);
  let total = 0;
  let current = new Date(dateDebut);
  const fin = new Date(dateFin);

  while (current <= fin) {
    const jourSemaine = current.getDay();
    const isWeekend = jourSemaine === 0 || jourSemaine === 6;
    const dateStr = current.toISOString().split('T')[0];
    const isFerie = joursFeriesService.estJourFerie(dateStr, joursFeries);
    if (!isWeekend && !isFerie) total += 1;
    current.setDate(current.getDate() + 1);
  }

  if (total > 0) {
    if (debut_demi === 'apres_midi') total -= 0.5;
    if (fin_demi === 'matin') total -= 0.5;
  }
  return total;
}

/* CRUD Congés */
async function createConge(req, res) {
  try {
    validateConge(req.body);
    const { conge_type_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee } = req.body;

    const utilisateur = await Utilisateur.findByPk(req.user.id, { include: ['entreprise'] });
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

    const congeType = await CongeType.findOne({ where: { id: conge_type_id, entreprise_id: utilisateur.entreprise_id } });
    if (!congeType) return res.status(404).json({ message: 'Type de congé introuvable' });

    const politique = getPolitiqueType(utilisateur.entreprise, congeType.code);
    const jours = await calcJoursConges(utilisateur.entreprise_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee);

    const annee = new Date().getFullYear();
    const compteur = await CompteurConges.findOne({ where: { utilisateur_id: utilisateur.id, conge_type_id, annee } });
    const solde = calculerSolde(compteur);

    if (!peutPoser(solde, jours, politique)) {
      return res.status(400).json({ message: 'Solde insuffisant selon la politique entreprise' });
    }

    const chevauche = await Conge.findOne({
      where: {
        utilisateur_id: utilisateur.id,
        statut: ['en_attente_manager', 'valide_manager', 'valide_final'],
        date_debut: { [Op.lte]: date_fin },
        date_fin: { [Op.gte]: date_debut }
      }
    });
    if (chevauche) return res.status(400).json({ message: 'Chevauchement de congés détecté' });

    const conge = await Conge.create({
      utilisateur_id: utilisateur.id,
      entreprise_id: utilisateur.entreprise_id,
      conge_type_id,
      date_debut,
      date_fin,
      debut_demi_journee,
      fin_demi_journee,
      statut: 'en_attente_manager'
    });

    // === Audit ===
    await auditConge(
      auditActions.CONGE_CREATED,
      conge.id,
      req.user.id,
      { dates: `${conge.date_debut} au ${conge.date_fin}`, type_conge: congeType.code }
    );

    res.status(201).json({ conge, jours_calcules: jours, message: 'Demande créée avec succès' });

  } catch (err) {
    if (err.message.includes('invalide') || err.message.includes('Dates invalides')) {
      return res.status(400).json({ message: err.message });
    }
    console.error('Erreur création congé:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function updateConge(req, res) {
  try {
    const conge = await Conge.findByPk(req.params.id, { include: ['utilisateur', 'entreprise', 'conge_type'] });
    if (!conge) return res.status(404).json({ message: 'Congé introuvable' });

    if (req.user.role !== 'super_admin' && req.user.entreprise_id !== conge.entreprise_id) {
      return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
    }

    const { statut, commentaire_manager, commentaire_admin } = req.body;
    const oldStatut = conge.statut;

    if (req.user.role === 'manager' && ['valide_manager', 'refuse_manager'].includes(statut)) {
      conge.statut = statut;
      conge.commentaire_manager = commentaire_manager;
    } else if (req.user.role === 'admin_entreprise' && ['valide_final', 'refuse_final'].includes(statut)) {
      conge.statut = statut;
      conge.commentaire_admin = commentaire_admin;
    } else if (req.user.role === 'super_admin') {
      conge.statut = statut;
      conge.commentaire_manager = commentaire_manager;
      conge.commentaire_admin = commentaire_admin;
    } else {
      return res.status(403).json({ message: 'Action non autorisée pour votre rôle' });
    }

    await conge.save();

    // === Audit ===
    if (oldStatut !== conge.statut) {
      await auditConge(
        auditActions.CONGE_APPROVED,
        conge.id,
        req.user.id,
        { oldStatut, newStatut: conge.statut }
      );
    }

    res.json({ conge, message: 'Congé mis à jour avec succès' });
  } catch (err) {
    console.error('Erreur mise à jour congé:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function deleteConge(req, res) {
  try {
    const conge = await Conge.findByPk(req.params.id);
    if (!conge) return res.status(404).json({ message: 'Congé introuvable' });

    if (req.user.role !== 'super_admin' && req.user.entreprise_id !== conge.entreprise_id) {
      return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
    }

    await conge.destroy();

    // === Audit ===
    await auditConge(
      auditActions.CONGE_DELETED,
      conge.id,
      req.user.id,
      { dates: `${conge.date_debut} au ${conge.date_fin}`, type_conge: conge.conge_type_id }
    );

    res.json({ message: 'Congé supprimé avec succès' });
  } catch (err) {
    console.error('Erreur suppression congé:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function getConges(req, res) {
  try {
    const where = {};
    switch (req.user.role) {
      case 'admin_entreprise':
        where.entreprise_id = req.user.entreprise_id;
        break;
      case 'manager':
      case 'employe':
        where.utilisateur_id = req.user.id;
        break;
    }

    const conges = await Conge.findAll({
      where,
      include: [
        { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'nom', 'email', 'role'] },
        { model: CongeType, as: 'conge_type', attributes: ['id', 'libelle', 'code'] }
      ],
      order: [['date_debut', 'DESC']]
    });

    res.json(conges);
  } catch (err) {
    console.error('Erreur récupération congés:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

module.exports = {
  createConge,
  updateConge,
  deleteConge,
  getConges,
  calcJoursConges
};