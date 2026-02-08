const express = require('express');
const router = express.Router();

// Healthcheck
router.get('/health', async (req, res) => {
  const sequelize = require('../config/database');
  try {
    await sequelize.authenticate();
    res.status(200).json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// Route test
router.get('/', (req, res) => {
  res.send('TeamOff Backend en marche !');
});

module.exports = router;
