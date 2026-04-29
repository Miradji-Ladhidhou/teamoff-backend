'use strict';
/**
 * stripForbiddenFields.js — Nettoyage du body selon le rôle.
 *
 * Défense en profondeur : le controller contient déjà les vérifications RBAC.
 * Ce middleware les précède et retire silencieusement les champs interdits
 * AVANT qu'ils n'atteignent le controller — même en cas de bug futur dans
 * celui-ci, les champs sensibles auront déjà été supprimés.
 *
 * ❌ Ne retourne jamais d'erreur : on retire, on ne bloque pas.
 * ✅ Aucune modification du flux de réponse.
 */

/**
 * Appliqué sur POST /api/users (création)
 *
 * admin_entreprise :
 *   - entreprise_id forcé à la sienne (impossible d'injecter une autre)
 *   - statut supprimé (le controller met toujours 'en_attente')
 *
 * super_admin : aucune restriction ici
 */
function forUserCreate(req, res, next) {
  if (req.user?.role === 'admin_entreprise') {
    req.body.entreprise_id = req.user.entreprise_id; // force son entreprise
    delete req.body.statut;                           // ne peut pas prédéfinir le statut
  }
  next();
}

/**
 * Appliqué sur PUT /api/users/:id (mise à jour)
 *
 * admin_entreprise :
 *   - ne peut pas changer entreprise_id
 *   - les restrictions de rôle sont vérifiées dans le controller
 *
 * Tous rôles non-super_admin :
 *   - ne peuvent pas modifier directement le champ "role" via cet endpoint
 *     (la route PUT /:id/role est réservée à super_admin via authorizeRole)
 *     — on retire quand même "role" du body pour les non-admins comme
 *     garde-fou contre une injection si authorizeRole laissait passer
 *
 * Note : super_admin peut tout modifier — aucune restriction ici.
 */
function forUserUpdate(req, res, next) {
  const userRole = req.user?.role;

  if (userRole === 'admin_entreprise') {
    delete req.body.entreprise_id; // ne peut pas déplacer l'utilisateur vers une autre entreprise
  }

  // employe / manager : autorisés à mettre à jour uniquement leur propre profil
  // via PUT /me — s'ils arrivent sur PUT /:id, authorizeRole a déjà bloqué
  // Mais en défense en profondeur, on retire les champs privilégiés
  if (['employe', 'manager'].includes(userRole)) {
    delete req.body.role;
    delete req.body.statut;
    delete req.body.entreprise_id;
    delete req.body.password;       // les non-admins n'ont pas le droit de forcer un mot de passe
  }

  next();
}

module.exports = { forUserCreate, forUserUpdate };
