require('dotenv').config();
const { syncTestListing } = require('../services/mlsService');

syncTestListing().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
