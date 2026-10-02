import { pool } from '../db/pool';

// Counts every purchase attempt by outcome so the dashboard can show demand, not just the
// orders that got through. Counting happens in memory and is flushed in one statement every
// FLUSH_MS, so 10,000 buyers do not become 10,000 extra writes competing with reservations.
// A worker that crashes loses at most one interval of counts; this is a metric, not a ledger.

const FLUSH_MS = 250;
const pending = new Map<string, number>(); // `${epochSecond}|${outcome}` -> count
let timer: NodeJS.Timeout | undefined;

export function recordAttempt(outcome: string): void {
  const key = `${Math.floor(Date.now() / 1000)}|${outcome}`;
  pending.set(key, (pending.get(key) ?? 0) + 1);
  timer ??= setTimeout(flush, FLUSH_MS);
}

export async function flush(): Promise<void> {
  timer = undefined;
  if (!pending.size) return;
  const rows = [...pending].map(([key, n]) => {
    const [sec, outcome] = key.split('|');
    return { sec: Number(sec), outcome, n };
  });
  pending.clear();
  try {
    await pool.query(
      `INSERT INTO purchase_attempts (second, outcome, n)
       SELECT to_timestamp(r.sec), r.outcome, r.n
       FROM jsonb_to_recordset($1::jsonb) AS r(sec bigint, outcome text, n int)
       ON CONFLICT (second, outcome) DO UPDATE SET n = purchase_attempts.n + EXCLUDED.n`,
      [JSON.stringify(rows)],
    );
  } catch (err) {
    console.error('[demand] flush failed:', (err as Error).message);
  }
}

/** Forget unflushed counts, so a reset does not leak the previous sale into the next. */
export function clearPendingAttempts(): void {
  pending.clear();
}
