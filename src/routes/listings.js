const express = require('express');
const router = express.Router();
const { getListings, getListing, getFeaturedListings } = require('../controllers/listingsController');

router.get('/listings/featured', getFeaturedListings);
router.get('/listings', getListings);
router.get('/listing/:id', getListing);

module.exports = router;
