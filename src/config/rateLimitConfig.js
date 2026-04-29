// config/rateLimitConfig.js

module.exports = {
  endpoints: {
    login: {
      key: 'login',
      points: 25, // 5x plus permissif pour les tests
      duration: 60,
      burst: 50,
      blockDuration: 10, // block plus court pour tests
    },
    forgotPassword: {
      key: 'forgotPassword',
      points: 10,
      duration: 60,
      burst: 15,
      blockDuration: 20,
    },
    conges: {
      key: 'conges',
      points: 150,
      duration: 60,
      burst: 250,
      blockDuration: 10,
    },
    refresh: {
      key: 'refresh',
      points: 20,
      duration: 60,
      burst: 30,
      blockDuration: 60,
    },
    getData: {
      key: 'getData',
      points: 500,
      duration: 60,
      burst: 1000,
      blockDuration: 5,
    },
    default: {
      key: 'default',
      points: 100,
      duration: 60,
      burst: 200,
      blockDuration: 10,
    },
  },
  whitelistRoles: ['super_admin'],
  whitelistHeader: 'x-internal-script',
};
