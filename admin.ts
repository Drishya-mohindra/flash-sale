import { pool } from '../db/pool';

export interface InvariantReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

/**
 * Cross-check the inventory counters against the orders that should account for them.
 * Runs in a REPEATABLE READ snapshot so both sides are read at the same instant.
 */
export async function checkInvariants(): Promise<InvariantReport> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: inv } = await c.query(
      `SELECT i.product_id, i.warehouse_id, i.total, i.available, i.reserved, i.sold,
              coalesce(o.holding, 0)::int AS holding_orders,
              coalesce(o.confirmed, 0)::int AS confirmed_orders
       FROM inventory i
       LEFT JOIN (
         SELECT product_id, warehouse_id,
                count(*) FILTER (WHERE state IN ('RESERVED', 'PAYMENT_PENDING')) AS holding,
                count(*) FILTER (WHERE state = 'CONFIRMED') AS confirmed
         FROM orders GROUP BY product_id, warehouse_id
       ) o USING (product_id, warehouse_id)
       ORDER BY i.warehouse_id`,
    );
    const { rows: dupBuyers } = await c.query(
      `SELECT count(*)::int AS n FROM (
         SELECT user_id FROM orders WHERE state = 'CONFIRMED'
         GROUP BY user_id, product_id HAVING count(*) > 1) d`,
    );
    const { rows: orphanHolds } = await c.query(
      `SELECT count(*)::int AS n FROM orders
       WHERE state IN ('RESERVED', 'PAYMENT_PENDING', 'CONFIRMED') AND warehouse_id IS NULL`,
    );
    await c.query('COMMIT');

    const checks: InvariantReport['checks'] = [];
    const totalUnits = inv.reduce((s, r) => s + r.total, 0);
    const soldUnits = inv.reduce((s, r) => s + r.sold, 0);
    const confirmed = inv.reduce((s, r) => s + r.confirmed_orders, 0);

    checks.push({
      name: 'never oversold',
      ok: soldUnits <= totalUnits && confirmed <= totalUnits,
      detail: `${confirmed} confirmed orders, ${soldUnits} units sold, ${totalUnits} units exist`,
    });
    for (const r of inv) {
      const balanced = r.available + r.reserved + r.sold === r.total;
      checks.push({
        name: `${r.warehouse_id}: units conserved`,
        ok: balanced,
        detail: `${r.available} available + ${r.reserved} reserved + ${r.sold} sold = ${r.total}`,
      });
      checks.push({
        name: `${r.warehouse_id}: reserved matches holding orders`,
        ok: r.reserved === r.holding_orders,
        detail: `${r.reserved} reserved units, ${r.holding_orders} RESERVED/PAYMENT_PENDING orders`,
      });
      checks.push({
        name: `${r.warehouse_id}: sold matches confirmed orders`,
        ok: r.sold === r.confirmed_orders,
        detail: `${r.sold} sold units, ${r.confirmed_orders} CONFIRMED orders`,
      });
    }
    checks.push({
      name: 'one unit per customer',
      ok: dupBuyers[0].n === 0,
      detail: `${dupBuyers[0].n} customers with more than one confirmed order`,
    });
    checks.push({
      name: 'every stock-holding order has a warehouse',
      ok: orphanHolds[0].n === 0,
      detail: `${orphanHolds[0].n} orders without a warehouse`,
    });
    return { ok: checks.every((ch) => ch.ok), checks };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

export async function getStats() {
  const [inventory, states, events, product, ledger, attempts, timeline, attemptsPerSecond, dbNow] =
    await Promise.all([
      pool.query(
        `SELECT i.warehouse_id, w.name, i.total, i.available, i.reserved, i.sold
         FROM inventory i JOIN warehouses w ON w.id = i.warehouse_id ORDER BY i.warehouse_id`,
      ),
      pool.query(`SELECT state, count(*)::int AS n FROM orders GROUP BY state`),
      pool.query(
        `SELECT order_id, from_state, to_state, reason, created_at
         FROM order_events ORDER BY id DESC LIMIT 25`,
      ),
      pool.query(`SELECT id, name, price_cents FROM products ORDER BY id LIMIT 1`),
      // Our side of the books: orders that reached the provider, to compare with its records.
      pool.query(`SELECT count(*)::int AS n FROM orders WHERE payment_id IS NOT NULL`),
      pool.query(`SELECT outcome, sum(n)::int AS n FROM purchase_attempts GROUP BY outcome`),
      // Sell-through history, rebuilt from the audit log in 100 ms buckets so it survives a
      // page refresh: each transition moves at most one unit into or out of sold / held.
      pool.query(
        `SELECT (floor(extract(epoch FROM created_at) * 10) * 100)::bigint AS t,
                sum((to_state = 'CONFIRMED')::int
                    - (coalesce(from_state, '') = 'CONFIRMED')::int)::int AS sold,
                sum((to_state IN ('RESERVED', 'PAYMENT_PENDING'))::int
                    - (coalesce(from_state, '') IN ('RESERVED', 'PAYMENT_PENDING'))::int)::int AS held
         FROM order_events GROUP BY 1 ORDER BY 1`,
      ),
      pool.query(
        `SELECT (extract(epoch FROM second) * 1000)::bigint AS t, sum(n)::int AS n
         FROM purchase_attempts GROUP BY 1 ORDER BY 1`,
      ),
      pool.query(`SELECT (extract(epoch FROM now()) * 1000)::bigint AS now`),
    ]);
  return {
    product: product.rows[0] ?? null,
    paymentsRecorded: ledger.rows[0].n as number,
    attempts: Object.fromEntries(attempts.rows.map((r) => [r.outcome, r.n])),
    timeline: {
      now: Number(dbNow.rows[0].now),
      stock: timeline.rows.map((r) => [Number(r.t), r.sold, r.held]),
      attempts: attemptsPerSecond.rows.map((r) => [Number(r.t), r.n]),
    },
    inventory: inventory.rows,
    orders: Object.fromEntries(states.rows.map((r) => [r.state, r.n])),
    recentEvents: events.rows,
  };
}
