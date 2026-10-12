const CATEGORIES = ['conges', 'absence_exceptionnelle', 'maladie'];
const { Op } = require('sequelize');

function normalizeManagerCrossServicePolicy(policy = {}) {
  const legacyLeaveAction = policy.manager_can_validate_all_services === true;
  const legacyLeaveView = legacyLeaveAction || policy.manager_can_view_all_services === true;
  const legacyAbsenceView = policy.manager_can_view_all_absences === true;
  const result = {};
  for (const category of CATEGORIES) {
    const legacy = category === 'conges'
      ? { view: legacyLeaveView, email: legacyLeaveView, in_app: legacyLeaveView, participation: legacyLeaveAction ? 'action' : 'information' }
      : { view: legacyAbsenceView, email: legacyAbsenceView, in_app: false, participation: 'information' };
    const explicit = policy.manager_cross_service?.[category];
    result[category] = explicit && typeof explicit === 'object' && !Array.isArray(explicit)
      ? {
        view: explicit.view === true || explicit.participation === 'action',
        email: explicit.email === true,
        in_app: explicit.in_app === true,
        participation: explicit.participation === 'action' ? 'action' : 'information',
      }
      : legacy;
  }
  return result;
}

function validateManagerCrossServicePolicy(value) {
  if (value === undefined) return;
  const invalid = () => {
    throw Object.assign(new Error('Paramètres interservices invalides : catégories, canaux booléens et participation information/action attendus.'), { status: 400 });
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const [category, settings] of Object.entries(value)) {
    if (!CATEGORIES.includes(category) || !settings || typeof settings !== 'object' || Array.isArray(settings)) invalid();
    for (const [field, setting] of Object.entries(settings)) {
      if (['view', 'email', 'in_app'].includes(field)) {
        if (typeof setting !== 'boolean') invalid();
      } else if (field !== 'participation' || !['information', 'action'].includes(setting)) invalid();
    }
  }
}

function getManagerCategorySettings(rules, manager, category = 'conges') {
  if (!CATEGORIES.includes(category)) throw new Error(`Catégorie interservices inconnue : ${category}`);
  const service = String(manager?.service || '').trim();
  return normalizeManagerCrossServicePolicy(service ? rules?.service_policies?.[service] || {} : {})[category];
}

function resolveManagerDelivery({ rules, manager, targetService, category = 'conges', actionRequired = false, localEligible = true }) {
  const local = Boolean(manager?.service && targetService && manager.service === targetService);
  const settings = getManagerCategorySettings(rules, manager, category);
  const canAct = local || settings.participation === 'action';
  return {
    local,
    canView: local || settings.view,
    canAct,
    email: local ? localEligible : settings.email,
    in_app: local ? localEligible : settings.in_app,
    mode: actionRequired && canAct ? 'action' : 'information',
  };
}

function getManagerAbsenceScope(rules, manager, localUserIds) {
  return {
    [Op.or]: ['maladie', 'absence_exceptionnelle'].map(type => ({
      type_absence: type,
      ...(getManagerCategorySettings(rules, manager, type).view
        ? {}
        : { utilisateur_id: { [Op.in]: localUserIds } }),
    })),
  };
}

module.exports = {
  CATEGORIES,
  normalizeManagerCrossServicePolicy,
  validateManagerCrossServicePolicy,
  getManagerCategorySettings,
  resolveManagerDelivery,
  getManagerAbsenceScope,
};
