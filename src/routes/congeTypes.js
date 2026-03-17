const express = require('express');
const router = express.Router();

const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');

const { CongeType } = require('../models');

function getTargetEntrepriseId(req, { allowBody = false } = {}) {
  if (req.user?.role === 'super_admin') {
    if (req.query?.entreprise_id) return req.query.entreprise_id;
    if (allowBody && req.body?.entreprise_id) return req.body.entreprise_id;
  }

  return req.user?.entreprise_id || null;
}

// ----------------------------
// Créer un type de congé
// ----------------------------

router.post(
  '/',
  authJwt,
  authorizeRole(['super_admin','admin_entreprise']),
  async (req,res,next)=>{
    try{
      const entrepriseId = getTargetEntrepriseId(req, { allowBody: true });
      if (!entrepriseId) {
        return res.status(400).json({ message: 'entreprise_id est requis' });
      }

      const type = await CongeType.create({

        entreprise_id: entrepriseId,

        code: req.body.code,
        libelle: req.body.libelle,
        quota_annuel: req.body.quota_annuel,
        demi_journee_autorisee: req.body.demi_journee_autorisee

      });

      res.status(201).json(type);

    }catch(err){next(err);}
  }
);


// ----------------------------
// Lister les types de congé
// ----------------------------

router.get(
  '/',
  authJwt,
  async(req,res,next)=>{
    try{
      const entrepriseId = getTargetEntrepriseId(req);
      if (!entrepriseId) {
        return res.status(400).json({ message: 'entreprise_id est requis' });
      }

      const types = await CongeType.findAll({
        where:{
          entreprise_id:entrepriseId
        }
      });

      res.json(types);

    }catch(err){next(err);}
  }
);


// ----------------------------
// récupérer un type par ID
// ----------------------------

router.get(
  '/:id',
  authJwt,
  async(req,res,next)=>{
    try{
      const entrepriseId = getTargetEntrepriseId(req);
      if (!entrepriseId) {
        return res.status(400).json({ message: 'entreprise_id est requis' });
      }

      const type = await CongeType.findOne({
        where:{
          id:req.params.id,
          entreprise_id:entrepriseId
        }
      });

      if(!type){
        return res.status(404).json({message:'Type introuvable'});
      }

      res.json(type);

    }catch(err){next(err);}
  }
);

// ----------------------------
// modifier un type
// ----------------------------

router.put(
  '/:id',
  authJwt,
  authorizeRole(['super_admin','admin_entreprise']),
  async(req,res,next)=>{
    try{
      const entrepriseId = getTargetEntrepriseId(req, { allowBody: true });
      if (!entrepriseId) {
        return res.status(400).json({ message: 'entreprise_id est requis' });
      }

      const type = await CongeType.findOne({
        where:{
          id:req.params.id,
          entreprise_id:entrepriseId
        }
      });

      if(!type){
        return res.status(404).json({message:'Type introuvable'});
      }

      await type.update(req.body);

      res.json(type);

    }catch(err){next(err);}
  }
);

router.delete(
  '/:id',
  authJwt,
  authorizeRole(['super_admin','admin_entreprise']),
  async(req,res,next)=>{
    try{
      const entrepriseId = getTargetEntrepriseId(req);
      if (!entrepriseId) {
        return res.status(400).json({ message: 'entreprise_id est requis' });
      }

      const type = await CongeType.findOne({
        where:{
          id:req.params.id,
          entreprise_id:entrepriseId
        }
      });

      if(!type){
        return res.status(404).json({message:'Type introuvable'});
      }

      await type.destroy();

      res.status(204).send();

    }catch(err){next(err);}
  }
);


module.exports = router;