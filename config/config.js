'use strict';

const safety = require('./migrationSafety');
const environment = safety.assertCliInvocation();
const config = safety.loadMigrationConfig(environment);
const url = safety.parseDatabaseUrl(config.url);

module.exports = {
  [environment]: {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    dialect: 'postgres',
    logging: false,
    dialectOptions: { ssl: config.ssl },
    hooks: {
      async afterConnect(connection) {
        try {
          await safety.verifyConnection(connection, config.target);
        } catch (error) {
          await connection.end();
          throw error;
        }
      },
    },
  },
};
