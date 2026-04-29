const express = require('express');
const router = express.Router();
const { getCalendrier } = require('../controllers/calendrierController');

router.get('/', getCalendrier);
router.get('/:year/:month', getCalendrier);

module.exports = router;