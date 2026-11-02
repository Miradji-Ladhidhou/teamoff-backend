'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/isolated-integration/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/test/harness/setup.js'],
  clearMocks: true,
};
