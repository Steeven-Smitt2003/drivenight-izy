import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compilePostgresQuery,
  openPostgresDatabase,
} from '../src/db/index.mjs';

test('PostgreSQL query construction converts SQLite placeholders and case-insensitive lookup', () => {
  assert.equal(
    compilePostgresQuery(
      "SELECT * FROM users WHERE name = ? COLLATE NOCASE AND phone = ? AND note = '?' AND created_at < CURRENT_TIMESTAMP",
    ),
    "SELECT * FROM users WHERE lower(name) = lower($1) AND phone = $2 AND note = '?' AND created_at < CURRENT_TIMESTAMP",
  );
  assert.equal(compilePostgresQuery("SELECT * FROM users WHERE name LIKE ?"), "SELECT * FROM users WHERE name ILIKE $1");
  assert.equal(
    compilePostgresQuery("SELECT 'name = ? COLLATE NOCASE and LIKE ?' AS note WHERE name LIKE ?"),
    "SELECT 'name = ? COLLATE NOCASE and LIKE ?' AS note WHERE name ILIKE $1",
  );
});

test('PostgreSQL applies versioned schemas once and does not seed demo accounts by default', async () => {
  const calls = [];
  let boundParameters;
  let version = 0;
  const pool = {
    async query(sql, parameters) {
      calls.push(sql);
      boundParameters = parameters;
      if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      return { rows: [], rowCount: 1 };
    },
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          if (sql === 'SELECT MAX(version) AS version FROM schema_migrations') {
            return { rows: [{ version }] };
          }
          const insertedVersion = sql.match(/INSERT INTO schema_migrations \(version\) VALUES \((\d+)\)/);
          if (insertedVersion) version = Number(insertedVersion[1]);
          return { rows: [] };
        },
        release() {},
      };
    },
    async end() {},
  };
  const database = await openPostgresDatabase('postgresql://test.invalid/db', {
    poolFactory: () => pool,
    seedDemoData: false,
  });

  assert.equal(calls.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS users')).length, 1);
  assert.equal(calls.filter((sql) => sql.includes('CREATE TABLE email_challenges')).length, 1);
  assert.equal(calls.filter((sql) => sql.includes('CREATE TABLE email_otp_rate_limits')).length, 1);
  const schema = calls.find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS users'));
  assert.match(schema, /is_active SMALLINT NOT NULL DEFAULT 1/);
  assert.match(schema, /is_online SMALLINT NOT NULL DEFAULT 0/);
  assert.equal(calls.some((sql) => sql.includes('demo-admin-01')), false);
  assert.deepEqual(
    await database.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(true, 'account-id'),
    { changes: 1 },
  );
  assert.deepEqual(boundParameters, [1, 'account-id']);
  await database.close();
});

test('PostgreSQL migration startup skips an already-applied schema version', async () => {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          if (sql === 'SELECT MAX(version) AS version FROM schema_migrations') {
            return { rows: [{ version: 2 }] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
    async end() {},
  };
  const database = await openPostgresDatabase('postgresql://test.invalid/db', {
    poolFactory: () => pool,
    seedDemoData: false,
  });

  assert.equal(calls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS users')), false);
  await database.close();
});
