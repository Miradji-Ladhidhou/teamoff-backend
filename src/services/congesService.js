const { Conge, CompteurConges, CongeType, Utilisateur, sequelize } = require('../models');
const notificationService = require('./notificationService');
const { auditConge } = require('./auditHelper');
const joursFeriesService = require('./joursFeriesService');
const { Op } = require('sequelize');
const dayjs = require('dayjs');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');

dayjs.extend(isSameOrBefore);

// ----------------------------
// Calcul des jours ouvrés
// ----------------------------
async function calcJoursConges(entrepriseId, dateDebut, dateFin, debut_demi, fin_demi) {
  let total = 0;
  let current = dayjs(dateDebut);
  const end = dayjs(dateFin);

  // Récupérer les jours fériés de l'entreprise
  const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(entrepriseId);

  while (current.isSameOrBefore(end, 'day')) {
    const day = current.day();
    const dateStr = current.format('YYYY-MM-DD');

    // Vérifier si c'est un jour ouvré (lundi à vendredi) et pas férié
    if (day !== 0 && day !== 6 && !joursFeriesService.estJourFerie(dateStr, joursFeries)) {
      total++;
    }
    current = current.add(1,'day');
  }

  if (total > 0) {
    if (debut_demi === 'apres_midi') total -= 0.5;
    if (fin_demi === 'matin') total -= 0.5;
  }
  return total;
}

// ----------------------------
// Créer un congé
// ----------------------------
async function createConge({ utilisateur_id, conge_type_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee, commentaire_employe, reqUser }) {
  return sequelize.transaction(async (t) => {
    const utilisateur = await Utilisateur.findByPk(utilisateur_id, { transaction: t });
    if (!utilisateur) throw new Error('Utilisateur introuvable');

    const congeType = await CongeType.findByPk(conge_type_id, { transaction: t });
    if (!congeType) throw new Error('Type de congé invalide');

    // Vérification chevauchement
    const chevauche = await Conge.findOne({
      where: {
        utilisateur_id,
        statut: { [Op.in]: ['en_attente_manager','valide_manager','valide_final'] },
        date_debut: { [Op.lte]: date_fin },
        date_fin: { [Op.gte]: date_debut }
      },
      transaction: t
    });
    if (chevauche) throw new Error('Chevauchement de congé détecté');

    const jours = await calcJoursConges(utilisateur.entreprise_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee);

    // Compteur
    let compteur = await CompteurConges.findOne({
      where: { utilisateur_id, conge_type_id, annee: dayjs(date_debut).year() },
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!compteur) {
      compteur = await CompteurConges.create({
        utilisateur_id,
        entreprise_id: utilisateur.entreprise_id,
        conge_type_id,
        annee: dayjs(date_debut).year(),
        jours_acquis: congeType.quota_annuel ?? 0,
        jours_pris: 0,
        jours_reserves: 0
      }, { transaction: t });
    }

    if (jours > (compteur.jours_acquis - compteur.jours_pris - compteur.jours_reserves)) {
      throw new Error('Solde insuffisant');
    }

    compteur.jours_reserves += jours;
    await compteur.save({ transaction: t });

    const conge = await Conge.create({
      utilisateur_id,
      entreprise_id: utilisateur.entreprise_id,
      conge_type_id,
      date_debut,
      date_fin,
      debut_demi_journee,
      fin_demi_journee,
      commentaire_employe,
      statut: 'en_attente_manager',
      jours_calcules: jours
    }, { transaction: t });

    // Notification au manager et admin entreprise
    const manager = await Utilisateur.findOne({
      where: { entreprise_id: utilisateur.entreprise_id, role: 'manager' }
    });
    const admin = await Utilisateur.findOne({
      where: { entreprise_id: utilisateur.entreprise_id, role: 'admin_entreprise' }
    });

    if (manager) {
      await notificationService.sendEmail({
        to: manager.email,
        subject: `Nouvelle demande de congé de ${utilisateur.nom}`,
        html: `<p>Une nouvelle demande de congé a été créée par ${utilisateur.prenom} ${utilisateur.nom} du ${date_debut} au ${date_fin}.</p><p>Commentaire employé : ${commentaire_employe || 'Aucun'}</p><p>Veuillez la valider.</p>`
      });
      await notificationService.creerNotification({
        entreprise_id: utilisateur.entreprise_id,
        utilisateur_id: manager.id,
        type: 'conge_demande',
        message: `Nouvelle demande de congé de ${utilisateur.nom} (${date_debut} - ${date_fin})`,
        url: `/conges/${conge.id}`
      });
    }

    if (admin) {
      await notificationService.creerNotification({
        entreprise_id: utilisateur.entreprise_id,
        utilisateur_id: admin.id,
        type: 'conge_demande',
        message: `Nouvelle demande de congé de ${utilisateur.nom} (${date_debut} - ${date_fin})`,
        url: `/conges/${conge.id}`
      });
    }

    // Notification à l'employé : congé créé
    await notificationService.sendEmail({
      to: utilisateur.email,
      subject: 'Votre demande de congé a été créée',
      html: `<p>Votre demande de congé du ${date_debut} au ${date_fin} a été créée et est en attente de validation par votre manager.</p>`
    });
    await notificationService.creerNotification({
      entreprise_id: utilisateur.entreprise_id,
      utilisateur_id: utilisateur.id,
      type: 'conge_cree',
      message: `Votre congé du ${date_debut} au ${date_fin} est en attente de validation`,
      url: `/conges/${conge.id}`
    });

    // Audit
    await auditConge.created(conge, reqUser, req);

    return conge;
  });
}

// ----------------------------
// Valider un congé
// ----------------------------
async function validerConge(congeId, reqUser, commentaire = null) {
  return sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(congeId, { transaction: t });
    if (!conge) throw new Error('Congé introuvable');

    const utilisateur = await Utilisateur.findByPk(conge.utilisateur_id, { transaction: t });

    if (reqUser.role === 'manager') {
      conge.statut = 'valide_manager';
      conge.commentaire_manager = commentaire;
      await conge.save({ transaction: t });

      // Notification admin entreprise
      const admin = await Utilisateur.findOne({
        where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise' }
      });
      if (admin) {
        await notificationService.sendEmail({
          to: admin.email,
          subject: `Congé validé par le manager`,
          html: `<p>Le congé de ${utilisateur.nom} du ${conge.date_debut} au ${conge.date_fin} a été validé par le manager et nécessite votre validation finale.</p><p>Commentaire employé : ${conge.commentaire_employe || 'Aucun'}</p><p>Commentaire manager : ${conge.commentaire_manager || 'Aucun'}</p>`
        });
        await notificationService.creerNotification({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: admin.id,
          type: 'conge_valide_manager',
          message: `Congé de ${utilisateur.nom} validé par manager (${conge.date_debut} - ${conge.date_fin})`,
          url: `/conges/${conge.id}`
        });
      }

      // Audit
      await auditConge.approved(conge, reqUser, req);
    } else if (reqUser.role === 'admin_entreprise') {
      conge.statut = 'valide_final';
      conge.commentaire_admin = commentaire;
      await conge.save({ transaction: t });

      // Mise à jour compteur
      const compteur = await CompteurConges.findOne({
        where: {
          utilisateur_id: conge.utilisateur_id,
          conge_type_id: conge.conge_type_id,
          annee: dayjs(conge.date_debut).year()
        },
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      compteur.jours_pris += conge.jours_calcules;
      compteur.jours_reserves -= conge.jours_calcules;
      await compteur.save({ transaction: t });

      // Notification à l'employé
      await notificationService.sendLeaveStatusUpdate(conge, utilisateur, 'valide');
      await notificationService.creerNotification({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: utilisateur.id,
        type: 'conge_valide_final',
        message: `Votre congé du ${conge.date_debut} au ${conge.date_fin} a été approuvé`,
        url: `/conges/${conge.id}`
      });

      // Audit
      await auditConge.approved(conge, reqUser, req);
    } else {
      throw new Error('Action non autorisée');
    }

    return conge;
  });
}

// ----------------------------
// Refuser un congé
// ----------------------------
async function rejeterConge(congeId, reqUser, commentaire = null) {
  return sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(congeId, {
      include: [{ model: CongeType, as: 'conge_type' }],
      transaction: t
    });
    if (!conge) throw new Error('Congé introuvable');

    const utilisateur = await Utilisateur.findByPk(conge.utilisateur_id, { transaction: t });
    const ancienStatut = conge.statut;

    if (reqUser.role === 'manager') {
      if (ancienStatut !== 'en_attente_manager') throw new Error('Impossible de refuser ce congé');
      conge.statut = 'refuse_manager';
      conge.commentaire_manager = commentaire;
    } else if (reqUser.role === 'admin_entreprise') {
      if (ancienStatut !== 'valide_manager' && ancienStatut !== 'en_attente_manager') throw new Error('Impossible de refuser ce congé');
      conge.statut = 'refuse_final';
      conge.commentaire_admin = commentaire;
    } else {
      throw new Error('Action non autorisée');
    }

    await conge.save({ transaction: t });

    // Mise à jour compteur : rendre les jours disponibles
    const compteur = await CompteurConges.findOne({
      where: {
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee: dayjs(conge.date_debut).year()
      },
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (compteur) {
      if (ancienStatut === 'valide_final') {
        compteur.jours_pris = Math.max(0, compteur.jours_pris - conge.jours_calcules);
      } else {
        compteur.jours_reserves = Math.max(0, compteur.jours_reserves - conge.jours_calcules);
      }
      await compteur.save({ transaction: t });
    }

    // Notification à l'employé
    await notificationService.sendLeaveStatusUpdate(conge, utilisateur, 'refuse');
    await notificationService.creerNotification({
      entreprise_id: conge.entreprise_id,
      utilisateur_id: utilisateur.id,
      type: 'conge_refuse',
      message: `Votre congé du ${conge.date_debut} au ${conge.date_fin} a été refusé`,
      url: `/conges/${conge.id}`
    });

    // Audit
    await auditConge.rejected(conge, reqUser, req);

    return conge;
  });
}

// ----------------------------
// Liste et détails
// ----------------------------
async function getConges(user) {
  let where = {};
  if (user.role === 'employe') where.utilisateur_id = user.id;
  else if (user.role === 'manager' || user.role === 'admin_entreprise') where.entreprise_id = user.entreprise_id;

  return Conge.findAll({ where });
}

async function getCongeById(id, user) {
  const conge = await Conge.findByPk(id);
  if (!conge) throw new Error('Congé introuvable');
  if (user.role !== 'super_admin' && user.entreprise_id !== conge.entreprise_id && user.id !== conge.utilisateur_id)
    throw new Error('Accès interdit');
  return conge;
}

// ----------------------------
// Modifier et supprimer
// ----------------------------
async function updateConge(id, data, user) {
  const conge = await Conge.findByPk(id);
  if (!conge) throw new Error('Congé introuvable');
  if (conge.statut !== 'en_attente_manager') throw new Error('Modification impossible');

  // Certains clients envoient l'objet complet, y compris le statut.
  // Nous ignorons le statut ici (la validation doit passer par /validate).
  if ('statut' in data) {
    if (data.statut !== conge.statut) {
      throw new Error('Modification du statut non autorisée');
    }
    delete data.statut;
  }

  await conge.update(data);
  return conge;
}

async function deleteConge(id, user) {
  const conge = await Conge.findByPk(id);
  if (!conge) throw new Error('Congé introuvable');
  if (conge.statut !== 'en_attente_manager') throw new Error('Impossible de supprimer');

  const compteur = await CompteurConges.findOne({
    where: { utilisateur_id: conge.utilisateur_id, conge_type_id: conge.conge_type_id, annee: dayjs(conge.date_debut).year() }
  });
  compteur.jours_reserves -= conge.jours_calcules;
  await compteur.save();

  await conge.destroy();
}

module.exports = {
  createConge,
  getConges,
  getCongeById,
  updateConge,
  deleteConge,
  validerConge,
  rejeterConge,
  calcJoursConges
};