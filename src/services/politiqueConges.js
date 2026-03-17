const DEFAULT_LEAVE_POLICY = {
  overlap_policy: 'block',
  max_employees_on_leave: {
    global: null,
    by_service: {}
  },
  approval_workflow: 'manager_admin',
  minimum_notice_days: 0,
  max_consecutive_days: 365,
  notification_settings: {
    on_create: true,
    on_validate: true,
    on_reject: true,
  }
};

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

  const approvalWorkflow = ['auto', 'manager', 'manager_admin'].includes(rawPolicy?.approval_workflow)
    ? rawPolicy.approval_workflow
    : DEFAULT_LEAVE_POLICY.approval_workflow;

  const globalLimit = Number(rawPolicy?.max_employees_on_leave?.global);
  const normalizedGlobalLimit = Number.isFinite(globalLimit) && globalLimit > 0 ? globalLimit : null;

  return {
    overlap_policy: overlapPolicy,
    max_employees_on_leave: {
      global: normalizedGlobalLimit,
      by_service: rawPolicy?.max_employees_on_leave?.by_service || {},
    },
    approval_workflow: approvalWorkflow,
    minimum_notice_days: Math.max(0, Number(rawPolicy?.minimum_notice_days) || 0),
    max_consecutive_days: Math.max(1, Number(rawPolicy?.max_consecutive_days) || DEFAULT_LEAVE_POLICY.max_consecutive_days),
    notification_settings: normalizeNotificationSettings(rawPolicy?.notification_settings),
  };
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
};