import pg from 'pg';
import { config } from '../config';

export type Db = pg.Pool | pg.PoolClient;

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.poolSize,
});

pool.on('error', (err) => {
  // An idle client died (e.g. the database restarted). The pool replaces it.
  console.error('[db] idle client error:', err.message);
});

const RETRYABLE = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

/**
 * Run `fn` inside a READ COMMITTED transaction.
 *
 * Correctness does not depend on snapshot isolation: every stock change is a conditional
 * UPDATE that Postgres re-checks against the latest committed row under a row lock, and
 * every order change happens after `SELECT ... FOR UPDATE`. Deadlocks should not occur
 * because locks are always taken in the order orders -> inventory, but if Postgres ever
 * reports one we retry the whole transaction.
 */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (attempt < attempts && RETRYABLE.has((err as { code?: string }).code ?? '')) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
