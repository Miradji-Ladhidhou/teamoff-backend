const CATEGORIES = ['conges', 'absence_exceptionnelle', 'maladie'];
const { Op } = require('sequelize');

function getNamedRoute(rules, service, category, userId) {
  const services = rules?.notification_routing;
  if (!service || !userId || !services || !Object.hasOwn(services, service)) return undefined;
  return services[service]?.[category]?.[userId];
}

function getManagerGrantedServices(rules, manager, category = 'conges') {
  return Object.keys(rules?.notification_routing || {}).filter(service =>
    getNamedRoute(rules, service, category, manager?.id)?.mode === 'workflow');
}

function getManagerUserWhere(rules, manager, category = 'conges') {
  if (getManagerCategorySettings(rules, manager, category).view) return undefined;
  const granted = getManagerGrantedServices(rules, manager, category);
  if (!granted.length) return manager?.service ? { service: manager.service } : { id: manager?.id };
  const services = [...new Set([manager?.service, ...granted].filter(Boolean))];
  return services.length ? { [Op.or]: [{ id: manager?.id }, { service: { [Op.in]: services } }] } : { id: manager?.id };
}

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
  const route = getNamedRoute(rules, targetService, category, manager?.id);
  const canAct = local || settings.participation === 'action' || route?.mode === 'workflow';
  return {
    local,
    canView: local || settings.view || route?.mode === 'workflow',
    canAct,
    email: route?.mode ? route.mode !== 'none' && route.email : local ? localEligible : settings.email,
    in_app: route?.mode ? route.mode !== 'none' && route.in_app : local ? localEligible : settings.in_app,
    mode: route?.mode !== 'information' && actionRequired && canAct ? 'action' : 'information',
  };
}

function getManagerAbsenceScope(rules, manager, localUserIds) {
  return {
    [Op.or]: ['maladie', 'absence_exceptionnelle'].map(type => ({
      type_absence: type,
      ...(getManagerCategorySettings(rules, manager, type).view
        ? {}
        : getManagerGrantedServices(rules, manager, type).length ? { [Op.or]: [
          { utilisateur_id: { [Op.in]: localUserIds } },
          { '$utilisateur.service$': { [Op.in]: getManagerGrantedServices(rules, manager, type) } },
        ] } : { utilisateur_id: { [Op.in]: localUserIds } }),
    })),
  };
}

module.exports = {
  CATEGORIES,
  getNamedRoute,
  getManagerGrantedServices,
  getManagerUserWhere,
  normalizeManagerCrossServicePolicy,
  validateManagerCrossServicePolicy,
  getManagerCategorySettings,
  resolveManagerDelivery,
  getManagerAbsenceScope,
};
