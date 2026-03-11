const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const { getCalendrier } = require('../controllers/calendrierController');

router.get('/', authJwt, getCalendrier);

module.exports = router;