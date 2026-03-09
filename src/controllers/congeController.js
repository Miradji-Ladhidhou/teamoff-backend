const congesService = require('../services/congesService');
const { validateConge } = require('../utils/validation');

async function creerConge(req, res) {
  try {
    validateConge(req.body);
    const conge = await congesService.creerConge({ ...req.body, reqUser: req.user });
    res.status(201).json({ conge });
  } catch (err) {
    if (err.message.includes('Chevauchement')) return res.status(400).json({ message: err.message });
    if (err.message.includes('Solde insuffisant')) return res.status(403).json({ message: err.message });
    if (err.message.includes('introuvable') || err.message.includes('entreprise différente')) return res.status(404).json({ message: err.message });
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function listerConges(req, res) {
  try {
    let where = {};
    if (req.user.role === 'employe' || req.user.role === 'manager') where.utilisateur_id = req.user.id;
    else if (req.user.role === 'admin_entreprise') where.entreprise_id = req.user.entreprise_id;

    const conges = await require('../models').Conge.findAll({
      where,
      include: ['conge_type', 'entreprise', 'utilisateur'],
      order: [['date_debut', 'DESC']]
    });

    res.json(conges);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

module.exports = { creerConge, listerConges };