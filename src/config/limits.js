// Limites d'usage par plan d'abonnement
const PLAN_LIMITS = {
  free: {
    maxUsers: 5,
    maxCongesParMois: 50,
    maxJoursFeries: 10,
    features: ['basic_conges', 'basic_calendar']
  },
  starter: {
    maxUsers: 25,
    maxCongesParMois: 200,
    maxJoursFeries: 20,
    features: ['basic_conges', 'basic_calendar', 'email_notifications']
  },
  professional: {
    maxUsers: 100,
    maxCongesParMois: 1000,
    maxJoursFeries: 50,
    features: ['basic_conges', 'basic_calendar', 'email_notifications', 'advanced_reporting', 'api_access']
  },
  enterprise: {
    maxUsers: -1, // illimité
    maxCongesParMois: -1,
    maxJoursFeries: -1,
    features: ['all_features', 'custom_integrations', 'priority_support']
  }
};

// Fonction pour vérifier les limites
const checkLimits = async (entrepriseId, action) => {
  // TODO: Implémenter la vérification des limites basée sur le plan de l'entreprise
  // Pour l'instant, pas de limites
  return { allowed: true, remaining: -1 };
};

module.exports = { PLAN_LIMITS, checkLimits };