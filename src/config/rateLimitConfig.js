// config/rateLimitConfig.js

module.exports = {
  endpoints: {
    login: {
      key: 'login',
      points: 8,
      duration: 60,
      burst: 12,
      blockDuration: 60,
    },
    register: {
      key: 'register',
      points: 5,
      duration: 60,
      burst: 5,
      blockDuration: 300,
    },
    forgotPassword: {
      key: 'forgotPassword',
      points: 5,
      duration: 60,
      burst: 5,
      blockDuration: 120,
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
      points: 8,
      duration: 60,
      burst: 10,
      blockDuration: 120,
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
