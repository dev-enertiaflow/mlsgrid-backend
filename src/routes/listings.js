const express = require('express');
const router = express.Router();
const { getListings, getListing } = require('../controllers/listingsController');

router.get('/listings', getListings);
router.get('/listing/:id', getListing);

module.exports = router;
