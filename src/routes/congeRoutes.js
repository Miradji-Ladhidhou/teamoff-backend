const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/roles');
const { Utilisateur, CompteurConges, CongeType, Conge, Entreprise } = require('../models');
const { getPolitiqueType, peutPoser } = require('../utils/politiqueConges');

/* ======================================
   POST /conges/demande
   Création de congé
====================================== */
router.post(
  '/demande',
  authJwt,
  authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']),
  async (req, res) => {
    try {
      const { conge_type_id, jours, date_debut, date_fin, debut_demi_journee, fin_demi_journee } = req.body;

      const utilisateur = await Utilisateur.findByPk(req.user.id, { include: ['entreprise'] });
      if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

      const congeType = await CongeType.findOne({ where: { id: conge_type_id, entreprise_id: utilisateur.entreprise_id } });
      if (!congeType) return res.status(404).json({ message: 'Type de congé introuvable pour cette entreprise' });

      const politique = getPolitiqueType(utilisateur.entreprise, congeType.code);

      // Vérifier solde
      const annee = new Date().getFullYear();
      const compteur = await CompteurConges.findOne({
        where: { utilisateur_id: utilisateur.id, conge_type_id, annee }
      });
      const solde = (compteur?.jours_acquis ?? 0) - (compteur?.jours_pris ?? 0);
      if (!peutPoser(solde, jours, politique)) {
        return res.status(400).json({ message: 'Solde insuffisant selon la politique entreprise' });
      }

      // Vérifier chevauchement
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
        statut: 'en_attente_manager',
      });

      res.status(201).json({ conge, message: 'Demande créée avec succès' });
    } catch (err) {
      console.error('Erreur création congé:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

/* ======================================
   GET /conges
   Liste des congés selon rôle
====================================== */
router.get(
  '/',
  authJwt,
  authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']),
  async (req, res) => {
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
);

/* ======================================
   PUT /conges/:id
   Validation/refus selon rôle
====================================== */
router.put(
  '/:id',
  authJwt,
  authorizeRole(['manager', 'admin_entreprise', 'super_admin']),
  async (req, res) => {
    try {
      const conge = await Conge.findByPk(req.params.id, { include: ['utilisateur', 'entreprise', 'conge_type'] });
      if (!conge) return res.status(404).json({ message: 'Congé introuvable' });

      // Multi-tenant check
      if (req.user.role !== 'super_admin' && req.user.entreprise_id !== conge.entreprise_id) {
        return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
      }

      const { statut, commentaire_manager, commentaire_admin } = req.body;

      // Validation selon rôle
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

      // Mise à jour compteur uniquement si admin valide_final
      if (req.user.role === 'admin_entreprise' && statut === 'valide_final') {
        const jours = calcJours(conge.date_debut, conge.date_fin, conge.debut_demi_journee, conge.fin_demi_journee);

        let compteur = await CompteurConges.findOne({
          where: {
            utilisateur_id: conge.utilisateur_id,
            conge_type_id: conge.conge_type_id,
            annee: new Date(conge.date_debut).getFullYear()
          }
        });

        if (!compteur) {
          compteur = await CompteurConges.create({
            utilisateur_id: conge.utilisateur_id,
            conge_type_id: conge.conge_type_id,
            entreprise_id: conge.entreprise_id,
            annee: new Date(conge.date_debut).getFullYear(),
            jours_acquis: conge.conge_type.quota_annuel,
            jours_pris: 0,
          });
        }

        compteur.jours_pris += jours;
        await compteur.save();
      }

      await conge.save();
      res.json({ conge, message: 'Congé mis à jour avec succès' });

    } catch (err) {
      console.error('Erreur mise à jour congé:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

/* ======================================
   DELETE /conges/:id
   Suppression
====================================== */
router.delete(
  '/:id',
  authJwt,
  authorizeRole(['admin_entreprise', 'super_admin']),
  async (req, res) => {
    try {
      const conge = await Conge.findByPk(req.params.id);
      if (!conge) return res.status(404).json({ message: 'Congé introuvable' });

      if (req.user.role !== 'super_admin' && req.user.entreprise_id !== conge.entreprise_id) {
        return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
      }

      await conge.destroy();
      res.json({ message: 'Congé supprimé avec succès' });
    } catch (err) {
      console.error('Erreur suppression congé:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

/* ======================================
   Gestion types de congés par entreprise
====================================== */

// Créer type
router.post(
  '/:id/types',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise'], req => req.user.entreprise_id),
  async (req, res) => {
    try {
      const entreprise = await Entreprise.findByPk(req.params.id);
      if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

      const { libelle, code, quota_annuel = 0, demi_journee_autorisee = true } = req.body;

      const existing = await CongeType.findOne({ where: { code, entreprise_id: entreprise.id } });
      if (existing) return res.status(400).json({ message: 'Code déjà utilisé' });

      const type = await CongeType.create({
        libelle, code, entreprise_id: entreprise.id, quota_annuel, demi_journee_autorisee
      });

      res.status(201).json({ type, message: 'Type de congé créé' });
    } catch (err) {
      console.error('Erreur création type congé:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// Modifier type
router.put(
  '/:id/types/:typeId',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise'], req => req.user.entreprise_id),
  async (req, res) => {
    try {
      const entreprise = await Entreprise.findByPk(req.params.id);
      if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

      const type = await CongeType.findOne({ where: { id: req.params.typeId, entreprise_id: entreprise.id } });
      if (!type) return res.status(404).json({ message: 'Type introuvable' });

      const { libelle, code, quota_annuel, demi_journee_autorisee } = req.body;

      if (libelle) type.libelle = libelle;
      if (code) {
        const existing = await CongeType.findOne({
          where: { code, entreprise_id: entreprise.id, id: { [Op.ne]: type.id } }
        });
        if (existing) return res.status(400).json({ message: 'Code déjà utilisé' });
        type.code = code;
      }
      if (quota_annuel !== undefined) type.quota_annuel = quota_annuel;
      if (demi_journee_autorisee !== undefined) type.demi_journee_autorisee = demi_journee_autorisee;

      await type.save();
      res.json({ type, message: 'Type mis à jour' });
    } catch (err) {
      console.error('Erreur mise à jour type:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// Lister types
router.get(
  '/:id/types',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise'], req => req.user.entreprise_id),
  async (req, res) => {
    try {
      const types = await CongeType.findAll({ where: { entreprise_id: req.params.id } });
      res.json(types);
    } catch (err) {
      console.error('Erreur récupération types:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

// Supprimer type
router.delete(
  '/:id/types/:typeId',
  authJwt,
  authorizeRole(['super_admin', 'admin_entreprise'], req => req.user.entreprise_id),
  async (req, res) => {
    try {
      const type = await CongeType.findOne({ where: { id: req.params.typeId, entreprise_id: req.params.id } });
      if (!type) return res.status(404).json({ message: 'Type introuvable' });

      await type.destroy();
      res.json({ message: 'Type supprimé' });
    } catch (err) {
      console.error('Erreur suppression type:', err);
      res.status(500).json({ message: 'Erreur serveur', error: err.message });
    }
  }
);

/* ======================================
    Solde de congés pour un utilisateur
====================================== */
router.get(
  '/compteur/:utilisateur_id',
  authJwt,
  authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']),
  async (req, res) => {
    try {
      const { utilisateur_id } = req.params;
      const utilisateur = await Utilisateur.findByPk(utilisateur_id);
      if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

      // Multi-tenant check : un employé ne peut voir que son propre solde
      if (req.user.role === 'employe' && req.user.id !== utilisateur.id) {
        return res.status(403).json({ message: 'Accès interdit' });
      }

      const annee = new Date().getFullYear();

      const compteurs = await CompteurConges.findAll({
        where: { utilisateur_id, annee },
        include: [{ model: CongeType, as: 'conge_type', attributes: ['id', 'libelle', 'code', 'quota_annuel'] }]
      });

      const solde = compteurs.map(c => ({
        type: c.conge_type.code,
        libelle: c.conge_type.libelle,
        quota: c.conge_type.quota_annuel,
        jours_acquis: Number(c.jours_acquis),
        jours_pris: Number(c.jours_pris),
        solde_restant: Number(c.jours_acquis - c.jours_pris)
      }));

      res.json({ utilisateur_id, solde });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Erreur serveur' });
    }
  }
);

/* ======================================
    Initialiser compteur congés pour un utilisateur
====================================== */
router.post(
  '/compteur/:utilisateur_id/init',
  authJwt,
  authorizeRole(['admin_entreprise', 'super_admin']),
  async (req, res) => {
    try {
      const { utilisateur_id } = req.params;
      const utilisateur = await Utilisateur.findByPk(utilisateur_id, { include: ['entreprise'] });
      if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

      const types = await CongeType.findAll({ where: { entreprise_id: utilisateur.entreprise_id } });

      const annee = new Date().getFullYear();
      const created = [];

      for (const t of types) {
        const [compteur, createdFlag] = await CompteurConges.findOrCreate({
          where: { utilisateur_id, conge_type_id: t.id, annee },
          defaults: { entreprise_id: utilisateur.entreprise_id, jours_acquis: t.quota_annuel, jours_pris: 0 }
        });
        if (createdFlag) created.push(compteur);
      }

      res.json({ message: 'Compteurs initialisés', created_count: created.length });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Erreur serveur' });
    }
  }
);

/* ======================================
    Mettre à jour compteur congés pour un utilisateur
====================================== */
router.put(
  '/compteur/:utilisateur_id/:conge_type_id',
  authJwt,
  authorizeRole(['admin_entreprise', 'super_admin']),
  async (req, res) => {
    try {
      const { utilisateur_id, conge_type_id } = req.params;
      const { jours_acquis, jours_pris } = req.body;

      const utilisateur = await Utilisateur.findByPk(utilisateur_id);
      if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

      // Multi-tenant check
      if (req.user.role !== 'super_admin' && req.user.entreprise_id !== utilisateur.entreprise_id) {
        return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
      }

      const annee = new Date().getFullYear();

      const compteur = await CompteurConges.findOne({
        where: { utilisateur_id, conge_type_id, annee }
      });
      if (!compteur) return res.status(404).json({ message: 'Compteur introuvable' });

      if (jours_acquis !== undefined) compteur.jours_acquis = jours_acquis;
      if (jours_pris !== undefined) compteur.jours_pris = jours_pris;

      await compteur.save();
      res.json({ compteur, message: 'Compteur mis à jour' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Erreur serveur' });
    }
  }
);

/* ======================================
    Supprimer compteur congés pour un utilisateur
====================================== */
router.delete(
  '/compteur/:utilisateur_id/:conge_type_id',
  authJwt,
  authorizeRole(['admin_entreprise', 'super_admin']),
  async (req, res) => {
    try {
      const { utilisateur_id, conge_type_id } = req.params;

      const utilisateur = await Utilisateur.findByPk(utilisateur_id);
      if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

      // Multi-tenant check
      if (req.user.role !== 'super_admin' && req.user.entreprise_id !== utilisateur.entreprise_id) {
        return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
      }

      const annee = new Date().getFullYear();
      const compteur = await CompteurConges.findOne({ where: { utilisateur_id, conge_type_id, annee } });
      if (!compteur) return res.status(404).json({ message: 'Compteur introuvable' });

      await compteur.destroy();
      res.json({ message: 'Compteur supprimé' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Erreur serveur' });
    }
  }
);

module.exports = router;
