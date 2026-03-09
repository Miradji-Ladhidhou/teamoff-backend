const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Utilisateur } = require('../models');
const sendEmail = require('../services/emailService');

async function createUser(req, res) {
  const { nom, email, role, entreprise_id } = req.body;
  const user = req.user;

  // Vérifications hiérarchiques
  if (user.role === 'admin_entreprise' && !['manager', 'employe'].includes(role)) {
    return res.status(403).json({ message: 'Vous ne pouvez créer que manager ou employe' });
  }
  if (user.role === 'admin_entreprise' && entreprise_id !== user.entreprise_id) {
    return res.status(403).json({ message: 'Vous ne pouvez créer des utilisateurs que dans votre entreprise' });
  }

  try {
    const tempPassword = crypto.randomBytes(6).toString('hex'); // 12 caractères hex
    const hash = await bcrypt.hash(tempPassword, 10);

    const newUser = await Utilisateur.create({
      nom,
      email,
      role,
      entreprise_id,
      password_hash: hash,
      statut: 'en_attente',
    });

    await sendEmail({
      to: email,
      subject: 'Votre compte TeamOff',
      text: `Bonjour ${nom},\n\nVotre compte a été créé.\nMot de passe temporaire : ${tempPassword}\nMerci de le changer à votre première connexion.`
    });

    res.status(201).json({
      id: newUser.id,
      nom: newUser.nom,
      email: newUser.email,
      role: newUser.role,
      entreprise_id: newUser.entreprise_id,
      statut: newUser.statut,
      message: 'Utilisateur créé et email envoyé avec mot de passe temporaire'
    });
  } catch (err) {
    console.error('Erreur création utilisateur:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function getAllUsers(req, res) {
  try {
    let where = {};
    if (['admin_entreprise', 'manager'].includes(req.user.role)) {
      where.entreprise_id = req.user.entreprise_id;
    }

    const users = await Utilisateur.findAll({ where, order: [['nom', 'ASC']] });
    res.json(users);
  } catch (err) {
    console.error('Erreur récupération utilisateurs:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function getUserById(req, res) {
  try {
    const utilisateur = await Utilisateur.findByPk(req.params.id);
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

    if (['admin_entreprise','manager','employe'].includes(req.user.role) &&
        utilisateur.entreprise_id !== req.user.entreprise_id &&
        req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
    }

    res.json(utilisateur);
  } catch (err) {
    console.error('Erreur récupération utilisateur:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function updateUser(req, res) {
  try {
    const utilisateur = await Utilisateur.findByPk(req.params.id);
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

    if (req.user.role === 'admin_entreprise' && utilisateur.entreprise_id !== req.user.entreprise_id) {
      return res.status(403).json({ message: 'Vous ne pouvez modifier que les utilisateurs de votre entreprise' });
    }

    const { nom, email, role, statut, password } = req.body;

    if (req.user.role === 'admin_entreprise' && role && !['manager', 'employe'].includes(role)) {
      return res.status(403).json({ message: 'Vous ne pouvez attribuer que manager ou employe' });
    }

    if (password) {
      utilisateur.password_hash = await bcrypt.hash(password, 10);
    }

    await utilisateur.update({ nom, email, role, statut });

    res.json(utilisateur);
  } catch (err) {
    console.error('Erreur mise à jour utilisateur:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

async function deleteUser(req, res) {
  try {
    const utilisateur = await Utilisateur.findByPk(req.params.id);
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

    if (req.user.role === 'admin_entreprise' && utilisateur.entreprise_id !== req.user.entreprise_id) {
      return res.status(403).json({ message: 'Vous ne pouvez supprimer que les utilisateurs de votre entreprise' });
    }

    await utilisateur.destroy();
    res.json({ message: 'Utilisateur supprimé avec succès' });
  } catch (err) {
    console.error('Erreur suppression utilisateur:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

module.exports = {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser
};