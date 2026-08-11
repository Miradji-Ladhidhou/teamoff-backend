// config/rateLimitConfig.js

module.exports = {
  endpoints: {
    login: {
      key: 'login',
      points: 10,        // 10 tentatives / min par IP
      duration: 60,
      burst: 15,
      blockDuration: 60,
    },
    register: {
      key: 'register',
      points: 5,         // 5 inscriptions / min par IP (anti-abus)
      duration: 60,
      burst: 5,
      blockDuration: 300,
    },
    forgotPassword: {
      key: 'forgotPassword',
      points: 5,         // 5 demandes / min par IP
      duration: 60,
      burst: 5,
      blockDuration: 120,
    },
    conges: {
      key: 'conges',
      points: 300,       // 300 req / min par user (multi-onglets + polling)
      duration: 60,
      burst: 500,
      blockDuration: 5,
    },
    refresh: {
      key: 'refresh',
      points: 20,        // 20 refresh / min (multi-onglets + réveil Render)
      duration: 60,
      burst: 25,
      blockDuration: 30,
    },
    getData: {
      key: 'getData',
      points: 600,       // 600 req / min par user
      duration: 60,
      burst: 1000,
      blockDuration: 5,
    },
    profileUpdate: {
      key: 'profileUpdate',
      points: 30,        // 30 sauvegardes / min par user — permissif pour auto-save
      duration: 60,
      burst: 40,
      blockDuration: 10, // blocage court : pas une route de sécurité
    },
    default: {
      key: 'default',
      points: 300,       // 300 req / min par user pour les autres routes
      duration: 60,
      burst: 500,
      blockDuration: 5,
    },
  },
  whitelistRoles: ['super_admin'],
};
