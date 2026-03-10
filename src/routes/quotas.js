const express = require('express');
const router = express.Router();
const { initQuota, getSolde } = require('../controllers/quotasController');

router.post('/init', initQuota);
router.get('/solde/:utilisateur_id/:conge_type_id', getSolde);

module.exports = router;