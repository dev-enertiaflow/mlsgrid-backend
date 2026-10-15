require('dotenv').config();
const express = require('express');
const cors = require('cors');
const listingsRouter = require('./routes/listings');
const { startScheduler, stopScheduler } = require('./services/syncScheduler');

const app = express();
const PORT = process.env.PORT || 3000;

const path = require('path');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));
app.use('/api', listingsRouter);

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.ENABLE_SCHEDULER !== 'false') {
    startScheduler();
  } else {
    console.log('[Scheduler] Background sync disabled (ENABLE_SCHEDULER=false).');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use by another process.`);
    process.exit(1);
  } else {
    console.error('❌ Server error:', err.message);
  }
});

// Graceful shutdown — stop scheduler before process exits
process.on('SIGTERM', () => { stopScheduler(); server.close(); });
process.on('SIGINT', () => { stopScheduler(); server.close(); });
