const { sequelize } = require('../src/models');

// Setup before all tests
beforeAll(async () => {
  // Ensure database connection
  await sequelize.authenticate();
});

// Cleanup after each test
afterEach(async () => {
  // Clean up test data if needed
  // This can be customized based on test requirements
});

// Cleanup after all tests
afterAll(async () => {
  await sequelize.close();
});