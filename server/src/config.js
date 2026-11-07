'use strict';
/*
 * DOST-IskoLens configuration (Node.js backend).
 * Every value can be overridden in the .env file in the iskolens folder.
 * Production must set SECRET_KEY, DATABASE_URL and FORCE_HTTPS=1.
 */
const path = require('path');
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(PROJECT_DIR, '.env') });

const env = (name, def) => (process.env[name] !== undefined && process.env[name] !== '' ? process.env[name] : def);
const bool = (name, def) => ['1', 'true', 'yes', 'on'].includes(String(env(name, def ? '1' : '0')).toLowerCase());
const num = (name, def) => Number(env(name, def));
const INSTANCE_DIR = path.resolve(env('INSTANCE_DIR', path.join(PROJECT_DIR, 'instance')));

const config = {
  PROJECT_DIR,
  FRONTEND_DIR: path.join(PROJECT_DIR, 'frontend'),
  INSTANCE_DIR,
  PORT: num('PORT', 5000),
  HOST: env('HOST', '127.0.0.1'),
  SECRET_KEY: env('SECRET_KEY', 'dev-only-change-me'),
  // MySQL in production, e.g. mysql://iskolens:password@localhost:3306/iskolens
  // (the v3 form mysql+pymysql://... is accepted too). Without DATABASE_URL a
  // local SQLite file is used, the same file v3 used, so v3 data opens as is.
  DATABASE_URL: env('DATABASE_URL', `sqlite:///${path.join(INSTANCE_DIR, 'iskolens-dev.db')}`),

  // Sessions and security (Scope 1.5, NFR 9-13)
  SESSION_IDLE_MINUTES: num('SESSION_IDLE_MINUTES', 30),
  SESSION_MAX_HOURS: 12,
  MAX_FAILED_LOGINS: num('MAX_FAILED_LOGINS', 5),
  FORCE_HTTPS: bool('FORCE_HTTPS', false),
  TRUST_PROXY: bool('TRUST_PROXY', bool('FORCE_HTTPS', false)),
  BCRYPT_ROUNDS: num('BCRYPT_ROUNDS', 12),
  PASSWORD_MIN_LENGTH: 8,
  RESET_TOKEN_MINUTES: 30,
  INVITE_TOKEN_HOURS: 48,

  // Uploads (Scope 1.5: max 10 MB, .xlsx / .csv)
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,

  // Email: without MAIL_SERVER, messages are saved to instance/outbox
  MAIL_SERVER: env('MAIL_SERVER', ''),
  MAIL_PORT: num('MAIL_PORT', 587),
  MAIL_USE_TLS: bool('MAIL_USE_TLS', true),
  MAIL_USERNAME: env('MAIL_USERNAME', ''),
  MAIL_PASSWORD: env('MAIL_PASSWORD', ''),
  MAIL_FROM: env('MAIL_FROM', 'DOST-IskoLens <no-reply@localhost>'),
  PUBLIC_BASE_URL: env('PUBLIC_BASE_URL', 'http://localhost:5000'),

  // Academic standing rule (revised BPMN): 1st-2nd year need 85% (2.00);
  // 3rd year and up need a passing grade (75% / 3.00).
  GWA_REQUIRED_PERCENT_LOWER_YEARS: num('GWA_REQUIRED_PERCENT_LOWER_YEARS', 85),
  GWA_PASSING_PERCENT: num('GWA_PASSING_PERCENT', 75),
  GWA_REQUIRED_GRADE_LOWER_YEARS: num('GWA_REQUIRED_GRADE_LOWER_YEARS', 2.0),
  GWA_PASSING_GRADE: num('GWA_PASSING_GRADE', 3.0),
  GWA_LOWER_YEAR_LEVELS: [1, 2],

  // Supporting documents
  DOCUMENTS_DIR: path.resolve(env('DOCUMENTS_DIR', path.join(INSTANCE_DIR, 'documents'))),
  MAX_DOCUMENT_BYTES: 10 * 1024 * 1024,
  ALLOWED_DOCUMENT_TYPES: { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' },

  // Backups
  BACKUP_DIR: path.resolve(env('BACKUP_DIR', path.join(INSTANCE_DIR, 'backups'))),
  BACKUP_KEEP: num('BACKUP_KEEP', 30),
  BACKUP_KEY: env('BACKUP_KEY', ''),
  BACKUP_SCHEDULE: env('BACKUP_SCHEDULE', ''),     // e.g. "0 2 * * *" to back up daily at 2:00 AM from the server itself
  DIGEST_SCHEDULE: env('DIGEST_SCHEDULE', ''),     // e.g. "0 7 * * 1" for Mondays at 7:00 AM

  // Limits per network address (on top of per-account lockout)
  RATE_LIMIT_FAILED_LOGINS: num('RATE_LIMIT_FAILED_LOGINS', 20),
  RATE_LIMIT_PASSWORD_RESETS: num('RATE_LIMIT_PASSWORD_RESETS', 5),
  RATE_LIMIT_SIGNUPS: num('RATE_LIMIT_SIGNUPS', 10),

  // Data retention: follows the policy of DOST Davao Oriental as data controller
  RETENTION_YEARS: num('RETENTION_YEARS', 5),
  DPO_NAME: env('DPO_NAME', 'Data Protection Officer, DOST Davao Oriental'),
  DPO_EMAIL: env('DPO_EMAIL', 'dpo@your-office.gov.ph'),

  // Two-step verification: when 1, Administrators must set it up before using the system
  REQUIRE_ADMIN_2FA: bool('REQUIRE_ADMIN_2FA', false),
  // Public officer sign-up (with Administrator approval). Set to 0 to let only Administrators create accounts.
  ALLOW_SIGNUP: bool('ALLOW_SIGNUP', true),
  REPORTS_DIR: path.resolve(env('REPORTS_DIR', path.join(INSTANCE_DIR, 'reports'))),
  APP_STARTED_AT: new Date(),

  // Analytics / machine-learning service (Python, see ../analytics)
  ANALYTICS_URL: env('ANALYTICS_URL', 'http://127.0.0.1:8001'),
};

module.exports = config;
