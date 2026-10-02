import { readFileSync } from 'node:fs';
import { config, PRODUCT_ID } from '../config';
import { pool } from './pool';

const WAREHOUSE_NAMES: Record<string, string> = {
  blr: 'Bengaluru',
  del: 'Delhi',
  mum: 'Mumbai',
  hyd: 'Hyderabad',
  chn: 'Chennai',
};

export function parseSeedStock(spec = config.seedStock): Array<[string, number]> {
  return spec.split(',').map((part) => {
    const [id, qty] = part.split(':');
    return [id.trim(), Number(qty)];
  });
}

export async function migrate(): Promise<void> {
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  // Several cluster workers may start at once; serialise DDL with an advisory lock.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(42)');
    await client.query(sql);
    const { rows } = await client.query('SELECT count(*)::int AS n FROM inventory');
    if (rows[0].n === 0) await seed(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock(42)').catch(() => {});
    client.release();
  }
}

async function seed(client: { query: typeof pool.query }): Promise<void> {
  await client.query(
    `INSERT INTO products (id, name, price_cents) VALUES ($1, 'Flash Phone X', 4999900)
     ON CONFLICT (id) DO NOTHING`,
    [PRODUCT_ID],
  );
  for (const [warehouseId, qty] of parseSeedStock()) {
    await client.query(
      `INSERT INTO warehouses (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [warehouseId, WAREHOUSE_NAMES[warehouseId] ?? warehouseId],
    );
    await client.query(
      `INSERT INTO inventory (product_id, warehouse_id, total, available, reserved, sold)
       VALUES ($1, $2, $3, $3, 0, 0)`,
      [PRODUCT_ID, warehouseId, qty],
    );
  }
}

/** Wipe all orders and restock. Used by the load test and the demo between runs. */
export async function resetSale(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE order_events, payment_events, orders, purchase_attempts');
    await client.query('DELETE FROM inventory');
    await seed(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
