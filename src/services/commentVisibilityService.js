'use strict';

const { Entreprise, Utilisateur } = require('../models');
const { getNamedRoute } = require('./managerCrossServicePolicy');

const COMMENT_CATEGORIES = ['conges', 'absence_exceptionnelle', 'maladie'];
const COMMENT_ROLES = ['super_admin', 'admin_entreprise', 'manager', 'employe', 'apprenti'];
const isCommentField = key => /^(?:(?:ancien|nouveau)_)?commentaire(?:_|$)/.test(key) || key === 'comments_rows';

function canReadComments(preferences, recipient, category, ownerId, rules, service) {
  if (recipient.id && recipient.id === ownerId) return true;
  if (category === 'absence') {
    return ['absence_exceptionnelle', 'maladie'].every(item => canReadComments(preferences, recipient, item, ownerId, rules, service));
  }
  const route = getNamedRoute(rules, service, category, recipient.id);
  if (typeof route?.comments === 'boolean') return route.comments;
  if (!service && Object.values(rules?.notification_routing || {}).some(categories => categories[category]?.[recipient.id]?.comments === false)) return false;
  return preferences?.comment_reading?.[recipient.role]?.[category] !== false;
}

function maskCommentFields(data) {
  if (!data || typeof data !== 'object' || data instanceof Date) return data;
  if (Array.isArray(data)) return data.map(maskCommentFields);
  const plain = typeof data.toJSON === 'function' ? data.toJSON() : data;
  return Object.fromEntries(Object.entries(plain).map(([key, value]) => [
    key, isCommentField(key) ? null : maskCommentFields(value),
  ]));
}

async function filterRecordComments(data, recipient, category = 'conges') {
  const companies = new Map();
  const owners = new Map();
  async function visit(value, inherited = {}) {
    if (!value || typeof value !== 'object' || value instanceof Date) return value;
    if (Array.isArray(value)) return Promise.all(value.map(item => visit(item, inherited)));
    const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
    const companyId = plain.entreprise_id || inherited.companyId;
    const ownerId = plain.utilisateur_id || plain.metadata?.utilisateur_id || inherited.ownerId;
    const absenceType = plain.type_absence || plain.metadata?.type_absence;
    const recordCategory = absenceType === 'maladie' ? 'maladie'
      : absenceType === 'absence_exceptionnelle' ? 'absence_exceptionnelle'
        : plain.entity?.toLowerCase() === 'absence' ? 'absence' : inherited.category || category;
    const hasComments = Object.keys(plain).some(isCommentField);
    let restricted = false;
    if (hasComments && companyId && ownerId !== recipient.id) {
      if (!companies.has(companyId)) {
        companies.set(companyId, Entreprise.findByPk(companyId, { attributes: ['parametres', 'politique_conges'] }).then(company => {
          if (!company) throw Object.assign(new Error('Entreprise introuvable pour les droits des commentaires.'), { status: 404 });
          return company;
        }));
      }
      const company = await companies.get(companyId);
      let service = plain.utilisateur?.service || inherited.service;
      if (!service && ownerId && company.politique_conges?.notification_routing) {
        const key = `${companyId}:${ownerId}`;
        if (!owners.has(key)) owners.set(key, Utilisateur.findOne({ where: { id: ownerId, entreprise_id: companyId }, attributes: ['service'] }));
        service = (await owners.get(key))?.service;
      }
      restricted = !canReadComments(company.parametres?.notifications, recipient, recordCategory, ownerId, company.politique_conges, service);
    }
    const filtered = Object.fromEntries(await Promise.all(Object.entries(plain).map(async ([key, item]) => [
      key, restricted && isCommentField(key) ? null
        : await visit(item, { companyId, ownerId, category: recordCategory, service: plain.utilisateur?.service || inherited.service }),
    ])));
    if (restricted) filtered.comments_hidden = true;
    return filtered;
  }
  return visit(data);
}

module.exports = { COMMENT_CATEGORIES, COMMENT_ROLES, canReadComments, maskCommentFields, filterRecordComments };
