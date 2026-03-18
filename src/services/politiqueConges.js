const DEFAULT_LEAVE_POLICY = {
  overlap_policy: 'block',
  max_employees_on_leave: {
    global: null,
    by_service: {}
  },
  blocked_days: {
    exclude_weekends: true,
    exclude_holidays: true,
    count_saturday: false,
    count_sunday: false,
    include_saturday_after_friday: false,
    include_sunday_after_friday: false,
    weekdays: [],
    specific_dates: []
  },
  accrual_by_type: {},
  service_policies: {},
  approval_workflow: 'manager_admin',
  minimum_notice_days: 0,
  max_consecutive_days: 365,
  notification_settings: {
    on_create: true,
    on_validate: true,
    on_reject: true,
  }
};

function normalizeApprovalWorkflow(value, fallback = DEFAULT_LEAVE_POLICY.approval_workflow) {
  const map = {
    auto: 'auto',
    manager: 'manager',
    manager_admin: 'manager_admin',
    manager_only: 'manager_only',
    admin_only: 'admin_only',
  };

  return map[value] || fallback;
}

function normalizeBlockedDays(rawBlockedDays = {}) {
  const weekdays = Array.isArray(rawBlockedDays.weekdays)
    ? rawBlockedDays.weekdays
      .map((day) => Number(day))
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : [];

  const specificDates = Array.isArray(rawBlockedDays.specific_dates)
    ? [...new Set(rawBlockedDays.specific_dates
      .map((value) => String(value || '').trim())
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)))]
    : [];

  return {
    exclude_weekends: rawBlockedDays.exclude_weekends !== false,
    exclude_holidays: rawBlockedDays.exclude_holidays !== false,
    count_saturday: rawBlockedDays.count_saturday === true,
    count_sunday: rawBlockedDays.count_sunday === true,
    include_saturday_after_friday: rawBlockedDays.include_saturday_after_friday === true || rawBlockedDays.count_saturday === true,
    include_sunday_after_friday: rawBlockedDays.include_sunday_after_friday === true || rawBlockedDays.count_sunday === true,
    weekdays,
    specific_dates: specificDates,
  };
}

function normalizeAccrualByType(rawAccrualByType = {}) {
  if (!rawAccrualByType || typeof rawAccrualByType !== 'object') return {};

  return Object.entries(rawAccrualByType).reduce((acc, [congeTypeId, monthlyValue]) => {
    const parsed = Number(monthlyValue);
    if (Number.isFinite(parsed) && parsed >= 0) {
      acc[congeTypeId] = parsed;
    }
    return acc;
  }, {});
}

function normalizeNotificationSettings(settings = {}) {
  return {
    on_create: settings.on_create !== false,
    on_validate: settings.on_validate !== false,
    on_reject: settings.on_reject !== false,
  };
}

function normalizeLeavePolicy(rawPolicy = {}) {
  const overlapPolicy = ['block', 'warning', 'allow'].includes(rawPolicy?.overlap_policy)
    ? rawPolicy.overlap_policy
    : DEFAULT_LEAVE_POLICY.overlap_policy;

  const approvalWorkflow = normalizeApprovalWorkflow(rawPolicy?.approval_workflow);

  const globalLimit = Number(rawPolicy?.max_employees_on_leave?.global);
  const normalizedGlobalLimit = Number.isFinite(globalLimit) && globalLimit > 0 ? globalLimit : null;

  return {
    overlap_policy: overlapPolicy,
    max_employees_on_leave: {
      global: normalizedGlobalLimit,
      by_service: rawPolicy?.max_employees_on_leave?.by_service || {},
    },
    blocked_days: normalizeBlockedDays(rawPolicy?.blocked_days),
    accrual_by_type: normalizeAccrualByType(rawPolicy?.accrual_by_type),
    service_policies: rawPolicy?.service_policies || {},
    approval_workflow: approvalWorkflow,
    minimum_notice_days: Math.max(0, Number(rawPolicy?.minimum_notice_days) || 0),
    max_consecutive_days: Math.max(1, Number(rawPolicy?.max_consecutive_days) || DEFAULT_LEAVE_POLICY.max_consecutive_days),
    notification_settings: normalizeNotificationSettings(rawPolicy?.notification_settings),
    report_autorise: rawPolicy?.report_autorise === true,
    report_max_jours: Math.max(0, Number(rawPolicy?.report_max_jours) || 0),
  };
}

function getEffectiveLeaveRules(baseRules, service) {
  if (!service) return baseRules;

  const servicePolicy = baseRules?.service_policies?.[service];
  if (!servicePolicy || typeof servicePolicy !== 'object') return baseRules;

  const effective = {
    ...baseRules,
    max_employees_on_leave: {
      ...(baseRules.max_employees_on_leave || {}),
      by_service: { ...(baseRules.max_employees_on_leave?.by_service || {}) },
    },
  };

  if (['block', 'warning', 'allow'].includes(servicePolicy.overlap_policy)) {
    effective.overlap_policy = servicePolicy.overlap_policy;
  }

  if (['auto', 'manager', 'manager_admin', 'manager_only', 'admin_only'].includes(servicePolicy.approval_workflow)) {
    effective.approval_workflow = servicePolicy.approval_workflow;
  } else {
    effective.approval_workflow = normalizeApprovalWorkflow(servicePolicy.approval_workflow, effective.approval_workflow);
  }

  if (Number.isFinite(Number(servicePolicy.minimum_notice_days))) {
    effective.minimum_notice_days = Math.max(0, Number(servicePolicy.minimum_notice_days));
  }

  if (Number.isFinite(Number(servicePolicy.max_consecutive_days))) {
    effective.max_consecutive_days = Math.max(1, Number(servicePolicy.max_consecutive_days));
  }

  if (Number.isFinite(Number(servicePolicy.max_employees_on_leave))) {
    effective.max_employees_on_leave.by_service[service] = Math.max(0, Number(servicePolicy.max_employees_on_leave));
  }

  return effective;
}

/**
 * Récupère la politique de congé pour un type
 * @param {Object} entreprise - objet entreprise Sequelize
 * @param {string} codeConge - code du type de congé
 */
function getPolitiqueType(entreprise, codeConge) {
  const politique = entreprise?.politique_conges?.[codeConge] ?? {};
  return {
    solde_negatif_autorise: Boolean(politique.solde_negatif_autorise),
    report: Boolean(politique.report),
    max_report: Number(politique.max_report) || 0,
  };
}

/**
 * Calcul du solde disponible en tenant compte du report
 * @param {number} solde - solde actuel
 * @param {Object} politique - objet politique
 */
function calculSoldeAvecReport(solde, politique) {
  solde = Number(solde) || 0;
  if (!politique?.report) return solde;
  return solde > politique.max_report ? politique.max_report : solde;
}

/**
 * Vérifie si l'utilisateur peut poser le congé
 * @param {number} solde - solde disponible
 * @param {number} joursDemandes - nombre de jours demandés
 * @param {Object} politique - objet politique
 */
function peutPoser(solde, joursDemandes, politique) {
  solde = Number(solde) || 0;
  joursDemandes = Number(joursDemandes) || 0;
  return solde - joursDemandes >= 0 || Boolean(politique?.solde_negatif_autorise);
}

/**
 * Récupère toutes les politiques d'une entreprise
 * @param {Object} entreprise
 */
function getToutesPolitiques(entreprise) {
  return entreprise?.politique_conges ?? {};
}

function getLeaveRules(entreprise) {
  return normalizeLeavePolicy(entreprise?.politique_conges || {});
}

module.exports = {
  DEFAULT_LEAVE_POLICY,
  normalizeLeavePolicy,
  getPolitiqueType,
  calculSoldeAvecReport,
  peutPoser,
  getToutesPolitiques,
  getLeaveRules,
  getEffectiveLeaveRules,
};