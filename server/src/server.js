'use strict';
/* Starts DOST-IskoLens:  npm start  (or: node src/server.js) */
const cron = require('node-cron');
const config = require('./config');
const db = require('./db');
const { createSchema } = require('./schema');
const { createApp } = require('./app');

async function main() {
  if (config.SECRET_KEY === 'dev-only-change-me') console.warn('Using the development SECRET_KEY. Set SECRET_KEY before deploying.');
  // Adds any new tables or columns to an existing database (never removes data).
  try {
    const k = db();
    if (await k.schema.hasTable('users')) await createSchema((m) => console.info(m));
  } catch (err) { console.error('Database check failed:', err.message); }

  const app = createApp();
  app.listen(config.PORT, config.HOST, () => console.info(`DOST-IskoLens running on http://${config.HOST}:${config.PORT}`));

  // Optional in-process schedules (alternatively use Task Scheduler / cron with the CLI).
  if (config.BACKUP_SCHEDULE && cron.validate(config.BACKUP_SCHEDULE)) {
    cron.schedule(config.BACKUP_SCHEDULE, () => require('./cli').run(['backup']).catch((e) => console.error('Scheduled backup failed:', e.message)));
    console.info(`Daily backup scheduled: ${config.BACKUP_SCHEDULE}`);
  }
  if (config.DIGEST_SCHEDULE && cron.validate(config.DIGEST_SCHEDULE)) {
    cron.schedule(config.DIGEST_SCHEDULE, () => require('./cli').run(['send-digest']).catch((e) => console.error('Weekly digest failed:', e.message)));
    console.info(`Weekly digest scheduled: ${config.DIGEST_SCHEDULE}`);
  }
}
main();
