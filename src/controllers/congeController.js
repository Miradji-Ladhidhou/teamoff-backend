// /controllers/congeController.js
const { Op } = require('sequelize');
const { sequelize, Utilisateur, CompteurConges, CongeType, Conge, JoursFeries } = require('../models');
const { auditConge } = require('../services/auditHelper');
const { auditActions } = require('../services/auditActions');
const { getPolitiqueType, peutPoser } = require('../services/politiqueConges');

/* Helper pour calcul jours ouvrés */
async function calcJoursConges(entrepriseId, dateDebut, dateFin, debut_demi='matin', fin_demi='apres_midi') {
  const joursFeries = await JoursFeries.findAll({
    where: { entreprise_id: entrepriseId, date: { [Op.between]: [dateDebut, dateFin] } },
    attributes: ['date']
  });
  const jfSet = new Set(joursFeries.map(jf => jf.date.toISOString().slice(0,10)));

  let total = 0;
  let current = new Date(dateDebut);
  const fin = new Date(dateFin);

  while (current <= fin) {
    const day = current.getDay();
    const strDate = current.toISOString().slice(0,10);
    if (day !== 0 && day !== 6 && !jfSet.has(strDate)) total += 1;
    current.setDate(current.getDate() + 1);
  }

  if (total > 0) {
    if (debut_demi === 'apres_midi') total -= 0.5;
    if (fin_demi === 'matin') total -= 0.5;
  }
  return total;
}

/* CREATE Congé */
async function createConge({ utilisateur_id, conge_type_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee, reqUser }) {
  return sequelize.transaction(async (t) => {
    const utilisateur = await Utilisateur.findByPk(utilisateur_id, { include: ['entreprise'], transaction: t });
    if (!utilisateur) throw new Error('Utilisateur introuvable');
    if (reqUser.role !== 'super_admin' && reqUser.entreprise_id !== utilisateur.entreprise_id)
      throw new Error('Accès interdit : entreprise différente');

    const congeType = await CongeType.findByPk(conge_type_id, { transaction: t });
    if (!congeType || congeType.entreprise_id !== utilisateur.entreprise_id)
      throw new Error('Type de congé invalide');

    const politique = getPolitiqueType(utilisateur.entreprise, congeType.code);
    const annee = new Date(date_debut).getFullYear();

    let compteur = await CompteurConges.findOne({
      where: { utilisateur_id, conge_type_id, annee },
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!compteur) {
      compteur = await CompteurConges.create({
        utilisateur_id,
        entreprise_id: utilisateur.entreprise_id,
        conge_type_id,
        annee,
        jours_acquis: congeType.quota_annuel ?? 0,
        jours_pris: 0,
        jours_reportes: 0,
        jours_reserves: 0
      }, { transaction: t });
    }

    const chevauche = await Conge.findOne({
      where: {
        utilisateur_id,
        statut: ['en_attente_manager','valide_manager','valide_final'],
        date_debut: { [Op.lte]: date_fin },
        date_fin: { [Op.gte]: date_debut }
      },
      transaction: t
    });
    if (chevauche) throw new Error('Chevauchement de congé détecté');

    const jours_a_prendre = await calcJoursConges(utilisateur.entreprise_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee);

    const solde_total = compteur.getSoldeDisponible();
    if (!peutPoser(solde_total, jours_a_prendre, politique)) throw new Error('Solde insuffisant');

    const conge = await Conge.create({
      utilisateur_id,
      entreprise_id: utilisateur.entreprise_id,
      conge_type_id,
      date_debut,
      date_fin,
      debut_demi_journee,
      fin_demi_journee,
      statut: 'en_attente_manager',
      jours_calcules: jours_a_prendre
    }, { transaction: t });

    compteur.jours_reserves = parseFloat(compteur.jours_reserves) + parseFloat(jours_a_prendre);
    await compteur.save({ transaction: t });

    return conge;
  });
}

/* UPDATE Congé */
async function updateConge(req, res) {
  const t = await sequelize.transaction();
  try {
    const conge = await Conge.findByPk(req.params.id, { include: ['utilisateur','conge_type'], transaction: t });
    if (!conge) throw new Error('Congé introuvable');

    const { statut, commentaire_manager, commentaire_admin } = req.body;
    const oldStatut = conge.statut;

    if (req.user.role === 'manager' && ['valide_manager','refuse_manager'].includes(statut)) {
      conge.statut = statut;
      conge.commentaire_manager = commentaire_manager;
    } else if (req.user.role === 'admin_entreprise' && ['valide_final','refuse_final'].includes(statut)) {
      conge.statut = statut;
      conge.commentaire_admin = commentaire_admin;
    } else if (req.user.role === 'super_admin') {
      conge.statut = statut;
      conge.commentaire_manager = commentaire_manager;
      conge.commentaire_admin = commentaire_admin;
    } else {
      throw new Error('Action non autorisée pour votre rôle');
    }

    await conge.save({ transaction: t });

    if (oldStatut !== conge.statut) {
      await auditConge(auditActions.CONGE_APPROVED, conge.id, req.user.id, { oldStatut, newStatut: conge.statut });
    }

    await t.commit();
    res.json({ conge, message: 'Congé mis à jour avec succès' });
  } catch (err) {
    await t.rollback();
    res.status(400).json({ message: err.message });
  }
}

/* DELETE Congé */
async function deleteConge(req, res) {
  const t = await sequelize.transaction();
  try {
    const conge = await Conge.findByPk(req.params.id, { transaction: t });
    if (!conge) throw new Error('Congé introuvable');

    const compteur = await CompteurConges.findOne({
      where: { utilisateur_id: conge.utilisateur_id, conge_type_id: conge.conge_type_id, annee: new Date(conge.date_debut).getFullYear() },
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (conge.statut === 'valide_final') {
      compteur.jours_pris = parseFloat(compteur.jours_pris) - parseFloat(conge.jours_calcules);
    } else {
      compteur.jours_reserves = parseFloat(compteur.jours_reserves) - parseFloat(conge.jours_calcules);
    }
    await compteur.save({ transaction: t });

    await conge.destroy({ transaction: t });

    await auditConge(auditActions.CONGE_DELETED, conge.id, req.user.id, {
      dates: `${conge.date_debut} au ${conge.date_fin}`,
      type_conge: conge.conge_type_id
    });

    await t.commit();
    res.json({ message: 'Congé supprimé avec succès' });
  } catch (err) {
    await t.rollback();
    res.status(400).json({ message: err.message });
  }
}

/* GET Congés */
async function getConges(req, res) {
  try {
    const where = {};
    if (req.user.role === 'admin_entreprise') where.entreprise_id = req.user.entreprise_id;
    else if (['manager','employe'].includes(req.user.role)) where.utilisateur_id = req.user.id;

    const conges = await Conge.findAll({
      where,
      include: [
        { model: Utilisateur, as: 'utilisateur', attributes: ['id','nom','email','role'] },
        { model: CongeType, as: 'conge_type', attributes: ['id','libelle','code'] }
      ],
      order: [['date_debut','DESC']]
    });

    res.json(conges);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/* Valider Congé */
async function validerConge(req, res) {
  const t = await sequelize.transaction();
  try {
    const conge = await Conge.findByPk(req.params.id, { transaction: t });
    if (!conge) throw new Error("Congé introuvable");

    const compteur = await CompteurConges.findOne({
      where: { utilisateur_id: conge.utilisateur_id, conge_type_id: conge.conge_type_id, annee: new Date(conge.date_debut).getFullYear() },
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    const jours = conge.jours_calcules;
    compteur.jours_reserves -= jours;
    compteur.jours_pris += jours;
    await compteur.save({ transaction: t });

    conge.statut = "valide_final";
    await conge.save({ transaction: t });

    await t.commit();
    res.json(conge);
  } catch (err) {
    await t.rollback();
    res.status(400).json({ error: err.message });
  }
}

/* GET Historique Congés d'un Utilisateur */
async function getHistoriqueUtilisateur(req, res) {
  try {
    const userId = req.params.userId;
    const conges = await Conge.findAll({
      where: { utilisateur_id: userId },
      include: [
        { model: CongeType, as: 'conge_type', attributes: ['libelle','code'] }
      ],
      order: [['date_debut','DESC']]
    });
    res.json(conges);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = {
  createConge,
  updateConge,
  deleteConge,
  getConges,
  calcJoursConges,
  validerConge,
  getHistoriqueUtilisateur
};