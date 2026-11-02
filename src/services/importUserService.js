'use strict';

const { Utilisateur, sequelize } = require('../models');

async function getImportUser(values, transaction) {
  if (!transaction) throw new Error('Transaction obligatoire pour le salarié d’import.');
  const where = { email: values.email };
  const existing = await Utilisateur.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
  if (existing) return { user: existing, created: false };

  const candidate = Utilisateur.build(values);
  await candidate.validate();
  const [inserted] = await sequelize.query(`
    INSERT INTO public.utilisateur
      (id, nom, prenom, email, role, service, entreprise_id, date_embauche,
       password_hash, invite_token_hash, statut, created_at, updated_at)
    VALUES ($id, $nom, $prenom, $email, $role, $service, $entreprise_id, $date_embauche,
       $password_hash, $invite_token_hash, $statut, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (email) DO NOTHING RETURNING id
  `, {
    bind: {
      id: candidate.id, nom: candidate.nom, prenom: candidate.prenom,
      email: candidate.email, role: candidate.role, service: candidate.service,
      entreprise_id: candidate.entreprise_id, date_embauche: candidate.date_embauche,
      password_hash: candidate.password_hash, invite_token_hash: candidate.invite_token_hash,
      statut: candidate.statut,
    },
    transaction,
  });
  // The unique index arbitrates even an absent row. READ COMMITTED then sees
  // the winner; its company and invitation hash must never be overwritten.
  const user = await Utilisateur.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
  if (!user) throw new Error('Salarié d’import introuvable après création concurrente.');
  return { user, created: inserted.length === 1 };
}

module.exports = { getImportUser };
