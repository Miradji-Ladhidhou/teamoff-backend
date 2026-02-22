const { Conge, CompteurConges, CongeType, Utilisateur } = require('../models');
const politiqueService = require('../utils/politiqueConges');
const { Op } = require('sequelize');

// Création de congé
async function creerConge(req, res) {
  const { utilisateur_id, conge_type_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee } = req.body;

  try {
    const utilisateur = await Utilisateur.findByPk(utilisateur_id, { include: ['entreprise'] });
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

    // Vérification droit multi-tenant
    if (req.user.role !== 'super_admin' && req.user.entreprise_id !== utilisateur.entreprise_id) {
      return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
    }

    const congeType = await CongeType.findByPk(conge_type_id);
    if (!congeType || congeType.entreprise_id !== utilisateur.entreprise_id) {
      return res.status(404).json({ message: 'Type de congé introuvable ou entreprise différente' });
    }

    const politique = politiqueService.getPolitiqueType(utilisateur.entreprise, congeType.code);

    // Compteur
    const annee = new Date(date_debut).getFullYear();
    let compteur = await CompteurConges.findOne({
      where: { utilisateur_id, conge_type_id, annee }
    });
    if (!compteur) {
      compteur = await CompteurConges.create({
        utilisateur_id,
        conge_type_id,
        entreprise_id: utilisateur.entreprise_id,
        annee,
        jours_acquis: congeType.quota_annuel,
        jours_pris: 0,
      });
    }


    // Chevauchement
    const chevauche = await Conge.findOne({
      where: {
        utilisateur_id,
        statut: ['en_attente_manager', 'valide_manager', 'valide_final'],
        date_debut: { [Op.lte]: date_fin },
        date_fin: { [Op.gte]: date_debut }
      }
    });
    if (chevauche) return res.status(400).json({ message: 'Chevauchement de congés détecté' });

    // Calcul des jours
    const jours_a_prendre = calcJours(date_debut, date_fin, debut_demi_journee, fin_demi_journee);
    const solde_disponible = (congeType.quota_annuel ?? 0) - compteur.jours_pris;

    if (!politique.solde_negatif_autorise && solde_disponible - jours_a_prendre < 0) {
      return res.status(403).json({ message: 'Solde insuffisant pour ce congé' });
    }

    const conge = await Conge.create({
      utilisateur_id,
      entreprise_id: utilisateur.entreprise_id,
      conge_type_id,
      date_debut,
      date_fin,
      debut_demi_journee,
      fin_demi_journee,
      statut: 'en_attente_manager'
    });

    // Mise à jour compteur
    compteur.jours_pris += jours_a_prendre;
    await compteur.save();

    res.status(201).json({ conge });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

// Lister congés
async function listerConges(req, res) {
  try {
    let where = {};
    if (req.user.role === 'employe' || req.user.role === 'manager') {
      where.utilisateur_id = req.user.id;
    } else if (req.user.role === 'admin_entreprise') {
      where.entreprise_id = req.user.entreprise_id;
    }
    const conges = await Conge.findAll({
      where,
      include: ['conge_type', 'entreprise', 'utilisateur'],
      order: [['date_debut', 'DESC']]
    });
    res.json(conges);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

// Calcul des jours avec demi-journée
function calcJours(dateDebut, dateFin, debut_demi, fin_demi) {
  const debut = new Date(dateDebut);
  const fin = new Date(dateFin);
  let jours = Math.floor((fin - debut) / (1000 * 60 * 60 * 24)) + 1;

  if (debut_demi === 'apres_midi') jours -= 0.5;
  if (fin_demi === 'matin') jours -= 0.5;

  return jours;
}

module.exports = { creerConge, listerConges };
