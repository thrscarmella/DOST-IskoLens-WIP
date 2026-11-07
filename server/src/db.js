'use strict';
/* Database connection (Knex). MySQL in production; SQLite for local testing. */
const fs = require('fs');
const path = require('path');
const knexLib = require('knex');
const config = require('./config');

function knexConfig(url) {
  if (url.startsWith('sqlite:///')) {
    const filename = url.slice('sqlite:///'.length);
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    return {
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      acquireConnectionTimeout: 10000,
      pool: { afterCreate: (conn, done) => { conn.pragma('foreign_keys = ON'); conn.pragma('journal_mode = WAL'); done(); } },
    };
  }
  const m = /^mysql(?:\+\w+)?:\/\/([^:@/]*)(?::([^@/]*))?@([^:/?]+)(?::(\d+))?\/([^?]+)/.exec(url);
  if (!m) throw new Error('DATABASE_URL must start with sqlite:/// or mysql://');
  return {
    client: 'mysql2',
    connection: {
      user: decodeURIComponent(m[1]), password: decodeURIComponent(m[2] || ''), host: m[3],
      port: Number(m[4] || 3306), database: m[5], charset: 'utf8mb4',
      dateStrings: true,          // DATE/DATETIME come back as plain strings, like SQLite
      supportBigNumbers: true, decimalNumbers: true, timezone: 'Z',
    },
    pool: { min: 0, max: 10 },
  };
}

let instance = null;
function db() {
  if (!instance) instance = knexLib(knexConfig(config.DATABASE_URL));
  return instance;
}
db.isMySQL = () => db().client.config.client === 'mysql2';
db.isSQLite = () => !db.isMySQL();
db.reset = async () => { if (instance) await instance.destroy(); instance = null; };
/* "a || ' ' || b" on SQLite, CONCAT(a, ' ', b) on MySQL */
db.concat = (...parts) => (db.isMySQL() ? `CONCAT(${parts.join(', ')})` : parts.join(' || '));
module.exports = db;
