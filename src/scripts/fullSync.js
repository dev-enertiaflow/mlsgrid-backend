require('dotenv').config();
const { syncAllListings } = require('../services/mlsService');

const resume = process.argv.includes('--resume');

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

if (resume) {
  console.log('Resume mode: picking up from greatest ModificationTimestamp in DB.');
}
if (limit) {
  console.log(`Limit mode: stopping after ${limit} listings.`);
}

syncAllListings({ resume, limit })
  .then(({ totalSynced, greatestTs }) => {
    console.log(`\nBatch sync complete. Synced: ${totalSynced} | Last timestamp: ${greatestTs}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Full sync failed:', err.message);
    process.exit(1);
  });
