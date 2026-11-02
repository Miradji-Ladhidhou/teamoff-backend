'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/phase5/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/test/harness/offline.js'],
  clearMocks: true,
};
