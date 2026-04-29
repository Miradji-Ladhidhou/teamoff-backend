module.exports = {
  testEnvironment: 'node',

  // Exécution séquentielle obligatoire pour les tests d'intégration
  // (évite les race conditions sur la DB partagée)
  runInBand: true,

  testMatch: ['**/test/**/*.test.js'],

  // Exclure les helpers du coverage
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',
    '!src/config/**/*.js',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],

  // Setup par fichier (connexion DB)
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],

  // Setup/teardown global (migrations, fermeture connexions)
  globalSetup:    '<rootDir>/test/global-setup.js',
  globalTeardown: '<rootDir>/test/global-teardown.js',

  // Délai généreux pour les opérations DB + migrations
  testTimeout: 30000,

  verbose: true,

  // Ignorer les anciens fichiers de vérification manuelle
  testPathIgnorePatterns: [
    '/node_modules/',
    '/scripts/',
  ],
};
