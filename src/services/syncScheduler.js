const { incrementalSync } = require('./mlsService');

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

let schedulerTimer = null;
let isRunning = false;
let lastFeedSyncAt = new Date().toISOString();

function getLastFeedSyncAt() {
  return lastFeedSyncAt;
}

async function runSync() {
  if (isRunning) {
    console.log('[Scheduler] Sync already in progress, skipping this tick.');
    return;
  }

  isRunning = true;
  console.log(`[Scheduler] Starting incremental sync at ${new Date().toISOString()}`);

  try {
    const { totalSynced, totalDeleted, greatestTs } = await incrementalSync();
    lastFeedSyncAt = new Date().toISOString();
    console.log(
      `[Scheduler] Incremental sync done — synced: ${totalSynced}, deleted: ${totalDeleted}, feed checked at: ${lastFeedSyncAt}`
    );
  } catch (err) {
    console.error(`[Scheduler] Incremental sync error: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

function startScheduler() {
  console.log(`[Scheduler] Incremental sync scheduled every 15 minutes.`);

  // Run immediately on startup, then every 15 min
  runSync();
  schedulerTimer = setInterval(runSync, INTERVAL_MS);
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[Scheduler] Stopped.');
  }
}

module.exports = { startScheduler, stopScheduler, getLastFeedSyncAt };
