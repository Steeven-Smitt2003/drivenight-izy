import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';

const migrations = [
  {
    version: 1,
    sql: readFileSync(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8'),
  },
  {
    version: 2,
    sql: readFileSync(new URL('./migrations/002_user_email.sql', import.meta.url), 'utf8'),
  },
  {
    version: 3,
    sql: readFileSync(new URL('./migrations/003_user_password.sql', import.meta.url), 'utf8'),
  },
  {
    version: 4,
    sql: readFileSync(new URL('./migrations/004_user_terms_consent.sql', import.meta.url), 'utf8'),
  },
  {
    version: 5,
    sql: readFileSync(new URL('./migrations/005_driver_vehicle_details.sql', import.meta.url), 'utf8'),
  },
  {
    version: 6,
    sql: readFileSync(new URL('./migrations/006_ride_locations.sql', import.meta.url), 'utf8'),
  },
  {
    version: 7,
    sql: readFileSync(new URL('./migrations/007_driver_vehicles.sql', import.meta.url), 'utf8'),
  },
  {
    version: 8,
    sql: readFileSync(new URL('./migrations/008_single_driver_vehicle.sql', import.meta.url), 'utf8'),
  },
  {
    version: 9,
    sql: readFileSync(new URL('./migrations/009_offer_expiration.sql', import.meta.url), 'utf8'),
  },
  {
    version: 10,
    sql: readFileSync(new URL('./migrations/010_remove_driver_approval.sql', import.meta.url), 'utf8'),
  },
  {
    version: 11,
    sql: readFileSync(new URL('./migrations/011_email_challenges.sql', import.meta.url), 'utf8'),
  },
];
const postgresMigrations = [
  {
    version: 1,
    sql: readFileSync(new URL('./migrations/postgres/001_initial.sql', import.meta.url), 'utf8'),
  },
  {
    version: 2,
    sql: readFileSync(new URL('./migrations/postgres/002_email_challenges.sql', import.meta.url), 'utf8'),
  },
];
const seedSql = readFileSync(new URL('./seed.sql', import.meta.url), 'utf8');

export function openDatabase(databasePath = process.env.DB_PATH ?? './server/data/drivenight.sqlite') {
  const resolvedPath = databasePath === ':memory:' ? databasePath : resolve(databasePath);
  if (resolvedPath !== ':memory:') mkdirSync(dirname(resolvedPath), { recursive: true });

  const database = new Database(resolvedPath);
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    if (resolvedPath !== ':memory:') database.pragma('journal_mode = WAL');
    runMigrations(database);
    database.exec(seedSql);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function createSQLitePersistence(database) {
  const transactionContext = new AsyncLocalStorage();
  let queue = Promise.resolve();

  function schedule(operation) {
    if (transactionContext.getStore() === database) return Promise.resolve().then(operation);
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  return {
    prepare(sql) {
      return {
        get: (...parameters) => schedule(() => database.prepare(sql).get(...parameters)),
        all: (...parameters) => schedule(() => database.prepare(sql).all(...parameters)),
        run: (...parameters) => schedule(() => database.prepare(sql).run(...parameters)),
      };
    },
    transaction(callback) {
      return (...args) => schedule(async () => {
        database.exec('BEGIN');
        try {
          const result = await transactionContext.run(database, () => callback(...args));
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      });
    },
    async close() {
      await queue;
      database.close();
    },
  };
}

export async function openPostgresDatabase(databaseUrl, {
  poolFactory = (options) => new Pool(options),
  seedDemoData = process.env.SEED_DEMO_DATA === 'true',
  environment = process.env.NODE_ENV ?? 'development',
} = {}) {
  if (seedDemoData && environment === 'production') {
    throw new Error('SEED_DEMO_DATA ne peut pas être activé en production.');
  }
  const pool = poolFactory({ connectionString: databaseUrl });
  const transactionContext = new AsyncLocalStorage();
  const query = async (sql, parameters = []) => {
    const client = transactionContext.getStore();
    const result = await (client ?? pool).query(
      compilePostgresQuery(sql),
      parameters.map((value) => typeof value === 'boolean' ? Number(value) : value),
    );
    for (const field of result.fields ?? []) {
      if (field.dataTypeID !== 20) continue;
      for (const row of result.rows) {
        const value = row[field.name];
        if (typeof value === 'string' && Number.isSafeInteger(Number(value))) {
          row[field.name] = Number(value);
        }
      }
    }
    return result;
  };

  try {
    await pool.query('SELECT 1');
    await runPostgresMigrations(pool);
    if (seedDemoData) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(seedSql);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    return {
      prepare(sql) {
        return {
          async get(...parameters) {
            const result = await query(sql, parameters);
            return result.rows[0];
          },
          async all(...parameters) {
            const result = await query(sql, parameters);
            return result.rows;
          },
          async run(...parameters) {
            const result = await query(sql, parameters);
            return { changes: result.rowCount };
          },
        };
      },
      transaction(callback) {
        return async (...args) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const result = await transactionContext.run(client, () => callback(...args));
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        };
      },
      close: () => pool.end(),
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export function compilePostgresQuery(sql) {
  let parameterIndex = 0;
  let result = '';
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      result += character;
      if (character === quote && sql[index + 1] === quote) {
        result += sql[++index];
      } else if (character === quote) {
        quote = null;
      }
    } else if (character !== "'" && character !== '"') {
      const collatedMatch = sql.slice(index).match(/^([\w.]+)\s*=\s*\?\s+COLLATE\s+NOCASE\b/i);
      if (collatedMatch) {
        result += `lower(${collatedMatch[1]}) = lower($${++parameterIndex})`;
        index += collatedMatch[0].length - 1;
      } else if (character === '?') {
        result += `$${++parameterIndex}`;
      } else if (/[A-Za-z_]/.test(character)) {
        const wordStart = index;
        while (/[A-Za-z_]/.test(sql[index] ?? '')) index += 1;
        const word = sql.slice(wordStart, index);
        result += word.toUpperCase() === 'LIKE' ? 'ILIKE' : word;
        index -= 1;
      } else {
        result += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
      result += character;
    }
  }
  return result;
}

async function runPostgresMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const latestVersion = postgresMigrations.at(-1)?.version ?? 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('drivenight-schema-migrations'))");
    const { rows } = await client.query('SELECT MAX(version) AS version FROM schema_migrations');
    const currentVersion = rows[0].version ?? 0;
    if (currentVersion > latestVersion) {
      throw new Error(`La base PostgreSQL (${currentVersion}) est plus récente que ce serveur (${latestVersion}).`);
    }
    for (const migration of postgresMigrations) {
      if (migration.version <= currentVersion) continue;
      await client.query(migration.sql);
      await client.query(`INSERT INTO schema_migrations (version) VALUES (${migration.version})`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function runMigrations(database) {
  const currentVersion = database.pragma('user_version', { simple: true });
  const latestVersion = migrations.at(-1)?.version ?? 0;

  if (currentVersion > latestVersion) {
    throw new Error(`La base SQLite (${currentVersion}) est plus récente que ce serveur (${latestVersion}).`);
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;

    database.transaction(() => {
      database.exec(migration.sql);
      database.pragma(`user_version = ${migration.version}`);
    })();
  }
}
