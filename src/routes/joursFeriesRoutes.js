const express = require('express');
const router = express.Router();

const { JoursFeries } = require('../models');

const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');



/**
 * LISTE des jours fériés de l'entreprise
 */
router.get(
  '/',
  authJwt,
  authorizeRole(['admin_entreprise', 'super_admin']),
  async (req, res) => {

    try {

      const joursFeries = await JoursFeries.findAll({
        where: {
          entreprise_id: req.user.entreprise_id
        },
        order: [['date', 'ASC']]
      });

      res.json(joursFeries);

    } catch (err) {

      console.error(err);

      res.status(500).json({
        message: 'Erreur serveur'
      });

    }
  }
);



/**
 * CREER un jour férié
 */
router.post(
  '/',
  authJwt,
  authorizeRole(['admin_entreprise', 'super_admin']),
  async (req, res) => {

    try {

      const { date, libelle, recurrent } = req.body;

      if (!date || !libelle) {
        return res.status(400).json({
          message: 'date et libelle requis'
        });
      }

      const jf = await JoursFeries.create({
        entreprise_id: req.user.entreprise_id,
        date,
        libelle,
        recurrent: recurrent || false
      });

      res.status(201).json(jf);

    } catch (err) {

      if (err.name === 'SequelizeUniqueConstraintError') {

        return res.status(409).json({
          message: 'Jour férié déjà existant'
        });

      }

      console.error(err);

      res.status(500).json({
        message: 'Erreur serveur'
      });

    }
  }
);



/**
 * MODIFIER un jour férié
 */
router.put(
  '/:id',
  authJwt,
  authorizeRole(['admin_entreprise', 'super_admin']),
  async (req, res) => {

    try {

      const jf = await JoursFeries.findOne({
        where: {
          id: req.params.id,
          entreprise_id: req.user.entreprise_id
        }
      });

      if (!jf) {

        return res.status(404).json({
          message: 'Jour férié introuvable'
        });

      }

      const { date, libelle, recurrent } = req.body;

      await jf.update({
        date,
        libelle,
        recurrent
      });

      res.json(jf);

    } catch (err) {

      if (err.name === 'SequelizeUniqueConstraintError') {

        return res.status(409).json({
          message: 'Jour férié déjà existant'
        });

      }

      console.error(err);

      res.status(500).json({
        message: 'Erreur serveur'
      });

    }
  }
);



/**
 * SUPPRIMER un jour férié
 */
router.delete(
  '/:id',
  authJwt,
  authorizeRole(['admin_entreprise', 'super_admin']),
  async (req, res) => {

    try {

      const jf = await JoursFeries.findOne({
        where: {
          id: req.params.id,
          entreprise_id: req.user.entreprise_id
        }
      });

      if (!jf) {

        return res.status(404).json({
          message: 'Jour férié introuvable'
        });

      }

      await jf.destroy();

      res.json({
        message: 'Jour férié supprimé'
      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        message: 'Erreur serveur'
      });

    }
  }
);


module.exports = router;