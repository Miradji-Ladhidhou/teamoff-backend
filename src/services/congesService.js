const { Conge, CompteurConges, CongeType, Utilisateur, Entreprise, sequelize } = require('../models');
const notificationService = require('./notificationService');
const { auditConge } = require('./auditHelper');
const joursFeriesService = require('./joursFeriesService');
const { Op } = require('sequelize');
const dayjs = require('dayjs');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
const { validateUUID, validateDateRange, validateDemiJournee } = require('../utils/validation');

dayjs.extend(isSameOrBefore);

function safeNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildDateKey(dateValue) {
  return dayjs(dateValue).format('YYYY-MM-DD');
}

function calculateBusinessDays(conge, joursFeriesSet) {
  let total = 0;
  let current = dayjs(conge.date_debut);
  const end = dayjs(conge.date_fin);

  while (current.isSameOrBefore(end, 'day')) {
    const day = current.day();
    const dateKey = current.format('YYYY-MM-DD');

    if (day !== 0 && day !== 6 && !joursFeriesSet.has(dateKey)) {
      total += 1;
    }

    current = current.add(1, 'day');
  }

  if (total > 0) {
    if (conge.debut_demi_journee === 'apres_midi') total -= 0.5;
    if (conge.fin_demi_journee === 'matin') total -= 0.5;
  }

  return total;
}

async function resolveCongeDays(conge) {
  const persisted = Number.parseFloat(conge.jours_calcules);
  if (Number.isFinite(persisted) && persisted > 0) {
    return persisted;
  }

  const computed = await calcJoursConges(
    conge.entreprise_id,
    conge.date_debut,
    conge.date_fin,
    conge.debut_demi_journee,
    conge.fin_demi_journee
  );

  return Number.isFinite(computed) ? computed : 0;
}

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
async function createConge({ utilisateur_id, conge_type_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee, commentaire_employe, reqUser, req }) {
  return sequelize.transaction(async (t) => {
    const utilisateurId = utilisateur_id || reqUser?.id;
    const debutDemiJournee = debut_demi_journee || 'matin';
    const finDemiJournee = fin_demi_journee || 'apres_midi';

    if (!validateUUID(utilisateurId)) throw new Error('utilisateur_id invalide');
    if (!validateUUID(conge_type_id)) throw new Error('conge_type_id invalide');
    if (!validateDateRange(date_debut, date_fin)) throw new Error('Dates invalides ou date_fin < date_debut');
    if (!validateDemiJournee(debutDemiJournee)) throw new Error('debut_demi_journee invalide');
    if (!validateDemiJournee(finDemiJournee)) throw new Error('fin_demi_journee invalide');
    if (date_debut === date_fin && debutDemiJournee === 'apres_midi' && finDemiJournee === 'matin') {
      throw new Error('Demi-journée incohérente sur une seule journée');
    }

    const utilisateur = await Utilisateur.findByPk(utilisateurId, { transaction: t });
    if (!utilisateur) throw new Error('Utilisateur introuvable');

    if (reqUser?.role === 'employe' && reqUser.id !== utilisateur.id) {
      throw new Error('Un employé ne peut créer un congé que pour lui-même');
    }

    if (reqUser?.role !== 'super_admin' && reqUser?.entreprise_id !== utilisateur.entreprise_id) {
      throw new Error('Accès interdit: entreprise différente');
    }

    const congeType = await CongeType.findByPk(conge_type_id, { transaction: t });
    if (!congeType) throw new Error('Type de congé invalide');

    if (congeType.entreprise_id !== utilisateur.entreprise_id) {
      throw new Error('Le type de congé ne correspond pas à l\'entreprise de l\'utilisateur');
    }

    if (!congeType.demi_journee_autorisee && (debutDemiJournee === 'apres_midi' || finDemiJournee === 'matin')) {
      throw new Error('Ce type de congé n\'autorise pas les demi-journées');
    }

    // Vérification chevauchement
    const chevauche = await Conge.findOne({
      where: {
        utilisateur_id: utilisateurId,
        statut: { [Op.in]: ['en_attente_manager','valide_manager','valide_final'] },
        date_debut: { [Op.lte]: date_fin },
        date_fin: { [Op.gte]: date_debut }
      },
      transaction: t
    });
    if (chevauche) throw new Error('Chevauchement de congé détecté');

    const jours = await calcJoursConges(utilisateur.entreprise_id, date_debut, date_fin, debutDemiJournee, finDemiJournee);
    if (!Number.isFinite(jours) || jours <= 0) throw new Error('Nombre de jours de congé invalide');

    // Compteur
    let compteur = await CompteurConges.findOne({
      where: { utilisateur_id: utilisateurId, conge_type_id, annee: dayjs(date_debut).year() },
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!compteur) {
      compteur = await CompteurConges.create({
        utilisateur_id: utilisateurId,
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

    compteur.jours_reserves = safeNumber(compteur.jours_reserves) + safeNumber(jours);
    await compteur.save({ transaction: t });

    const conge = await Conge.create({
      utilisateur_id: utilisateurId,
      entreprise_id: utilisateur.entreprise_id,
      conge_type_id,
      date_debut,
      date_fin,
      debut_demi_journee: debutDemiJournee,
      fin_demi_journee: finDemiJournee,
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
    await auditConge.created(conge, reqUser, req || null);

    return conge;
  });
}

// ----------------------------
// Valider un congé
// ----------------------------
async function validerConge(congeId, reqUser, commentaire = null, req = null) {
  return sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(congeId, { transaction: t });
    if (!conge) throw new Error('Congé introuvable');
    const joursConge = await resolveCongeDays(conge);

    const utilisateur = await Utilisateur.findByPk(conge.utilisateur_id, { transaction: t });

    if (reqUser.role === 'manager') {
      if (conge.statut !== 'en_attente_manager') {
        throw new Error('Impossible de valider ce congé à ce stade');
      }

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
    } else if (reqUser.role === 'admin_entreprise' || reqUser.role === 'super_admin') {
      if (!['en_attente_manager', 'valide_manager'].includes(conge.statut)) {
        throw new Error('Impossible de valider ce congé à ce stade');
      }

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
      if (!compteur) throw new Error('Compteur de congés introuvable pour validation');

      compteur.jours_pris = safeNumber(compteur.jours_pris) + safeNumber(joursConge);
      compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - safeNumber(joursConge));
      await compteur.save({ transaction: t });

      // Notification à l'employé
      await notificationService.sendEmail({
        to: utilisateur.email,
        subject: 'Votre demande de congé a été approuvée',
        html: `<p>Votre demande de congé du ${conge.date_debut} au ${conge.date_fin} a été approuvée.</p>`
      });
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
async function rejeterConge(congeId, reqUser, commentaire = null, req = null) {
  return sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(congeId, {
      include: [{ model: CongeType, as: 'conge_type' }],
      transaction: t
    });
    if (!conge) throw new Error('Congé introuvable');
    const joursConge = await resolveCongeDays(conge);

    const utilisateur = await Utilisateur.findByPk(conge.utilisateur_id, { transaction: t });
    const ancienStatut = conge.statut;

    if (reqUser.role === 'manager') {
      if (ancienStatut !== 'en_attente_manager') throw new Error('Impossible de refuser ce congé');
      conge.statut = 'refuse_manager';
      conge.commentaire_manager = commentaire;
    } else if (reqUser.role === 'admin_entreprise' || reqUser.role === 'super_admin') {
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
        compteur.jours_pris = Math.max(0, safeNumber(compteur.jours_pris) - safeNumber(joursConge));
      } else {
        compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - safeNumber(joursConge));
      }
      await compteur.save({ transaction: t });
    }

    // Notification à l'employé
    await notificationService.sendEmail({
      to: utilisateur.email,
      subject: 'Votre demande de congé a été refusée',
      html: `<p>Votre demande de congé du ${conge.date_debut} au ${conge.date_fin} a été refusée.</p>`
    });
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
  const where = {};
  if (user.role === 'employe') {
    where.utilisateur_id = user.id;
  } else if (user.role === 'manager' || user.role === 'admin_entreprise') {
    where.entreprise_id = user.entreprise_id;
  }

  const conges = await Conge.findAll({
    where,
    include: [
      {
        model: Utilisateur,
        as: 'utilisateur',
        attributes: ['id', 'prenom', 'nom', 'email']
      },
      {
        model: CongeType,
        as: 'conge_type',
        attributes: ['id', 'libelle']
      },
      {
        model: Entreprise,
        as: 'entreprise',
        attributes: ['id', 'nom']
      }
    ],
    order: [['created_at', 'DESC']]
  });

  if (conges.length === 0) {
    return [];
  }

  const entrepriseIds = [...new Set(conges.map((c) => c.entreprise_id).filter(Boolean))];
  const joursFeriesByEntreprise = new Map();

  await Promise.all(
    entrepriseIds.map(async (entrepriseId) => {
      try {
        const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(entrepriseId);
        const joursFeriesSet = new Set((joursFeries || []).map((jf) => buildDateKey(jf.date)));
        joursFeriesByEntreprise.set(entrepriseId, joursFeriesSet);
      } catch (_err) {
        joursFeriesByEntreprise.set(entrepriseId, new Set());
      }
    })
  );

  const compteurKeys = [];
  const uniqueCompteurKeys = new Set();

  conges.forEach((conge) => {
    const annee = dayjs(conge.date_debut).year();
    const key = `${conge.utilisateur_id}::${conge.conge_type_id}::${annee}`;
    if (!uniqueCompteurKeys.has(key)) {
      uniqueCompteurKeys.add(key);
      compteurKeys.push({
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee
      });
    }
  });

  const compteurs = await CompteurConges.findAll({
    where: {
      [Op.or]: compteurKeys
    },
    attributes: ['utilisateur_id', 'conge_type_id', 'annee', 'jours_acquis', 'jours_reportes', 'jours_reserves', 'jours_pris']
  });

  const soldeByKey = new Map();
  compteurs.forEach((compteur) => {
    const solde =
      parseFloat(compteur.jours_acquis || 0) +
      parseFloat(compteur.jours_reportes || 0) -
      parseFloat(compteur.jours_reserves || 0) -
      parseFloat(compteur.jours_pris || 0);
    const key = `${compteur.utilisateur_id}::${compteur.conge_type_id}::${compteur.annee}`;
    soldeByKey.set(key, Number.isFinite(solde) ? solde : null);
  });

  return conges.map((conge) => {
    const plainConge = conge.toJSON();
    const annee = dayjs(conge.date_debut).year();
    const compteurKey = `${conge.utilisateur_id}::${conge.conge_type_id}::${annee}`;
    const joursFeriesSet = joursFeriesByEntreprise.get(conge.entreprise_id) || new Set();
    const joursPris = Number.parseFloat(plainConge.jours_calcules);
    const joursPrisValue = Number.isFinite(joursPris)
      ? joursPris
      : calculateBusinessDays(conge, joursFeriesSet);

    return {
      ...plainConge,
      utilisateur_nom: plainConge.utilisateur
        ? `${plainConge.utilisateur.prenom || ''} ${plainConge.utilisateur.nom || ''}`.trim()
        : null,
      entreprise_nom: plainConge.entreprise?.nom || null,
      conge_type_libelle: plainConge.conge_type?.libelle || null,
      jours_pris: Number.isFinite(joursPrisValue) ? joursPrisValue : null,
      jours_restants: soldeByKey.has(compteurKey) ? soldeByKey.get(compteurKey) : null,
      date_demande: plainConge.created_at || plainConge.createdAt || null
    };
  });
}

async function getCongeById(id, user) {
  const conge = await Conge.findByPk(id, {
    include: [
      {
        model: Utilisateur,
        as: 'utilisateur',
        attributes: ['id', 'prenom', 'nom', 'email']
      },
      {
        model: CongeType,
        as: 'conge_type',
        attributes: ['id', 'libelle']
      },
      {
        model: Entreprise,
        as: 'entreprise',
        attributes: ['id', 'nom']
      }
    ]
  });
  if (!conge) throw new Error('Congé introuvable');
  if (user.role !== 'super_admin' && user.entreprise_id !== conge.entreprise_id && user.id !== conge.utilisateur_id)
    throw new Error('Accès interdit');

  const annee = dayjs(conge.date_debut).year();
  const compteur = await CompteurConges.findOne({
    where: {
      utilisateur_id: conge.utilisateur_id,
      conge_type_id: conge.conge_type_id,
      annee
    },
    attributes: ['jours_acquis', 'jours_reportes', 'jours_reserves', 'jours_pris']
  });

  let joursFeriesSet = new Set();
  try {
    const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(conge.entreprise_id);
    joursFeriesSet = new Set((joursFeries || []).map((jf) => buildDateKey(jf.date)));
  } catch (_err) {
    joursFeriesSet = new Set();
  }

  const plainConge = conge.toJSON();
  const joursPris = Number.parseFloat(plainConge.jours_calcules);
  const joursPrisValue = Number.isFinite(joursPris)
    ? joursPris
    : calculateBusinessDays(conge, joursFeriesSet);

  const joursRestants = compteur
    ? parseFloat(compteur.jours_acquis || 0) +
      parseFloat(compteur.jours_reportes || 0) -
      parseFloat(compteur.jours_reserves || 0) -
      parseFloat(compteur.jours_pris || 0)
    : null;

  return {
    ...plainConge,
    utilisateur_nom: plainConge.utilisateur
      ? `${plainConge.utilisateur.prenom || ''} ${plainConge.utilisateur.nom || ''}`.trim()
      : null,
    entreprise_nom: plainConge.entreprise?.nom || null,
    conge_type_libelle: plainConge.conge_type?.libelle || null,
    jours_pris: Number.isFinite(joursPrisValue) ? joursPrisValue : null,
    jours_restants: Number.isFinite(joursRestants) ? joursRestants : null,
    nombre_jours: Number.isFinite(joursPrisValue) ? joursPrisValue : plainConge.nombre_jours || null,
    date_demande: plainConge.created_at || plainConge.createdAt || null
  };
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

  const joursConge = await resolveCongeDays(conge);

  const compteur = await CompteurConges.findOne({
    where: { utilisateur_id: conge.utilisateur_id, conge_type_id: conge.conge_type_id, annee: dayjs(conge.date_debut).year() }
  });
  if (compteur) {
    compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - safeNumber(joursConge));
    await compteur.save();
  }

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