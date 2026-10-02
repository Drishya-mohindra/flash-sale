import type { PoolClient } from 'pg';
import type { StockMove } from '../domain/stateMachine';

// Each move is a single conditional UPDATE. Postgres takes a row lock on the inventory row
// and re-evaluates the WHERE clause against the latest committed version, so two
// concurrent buyers can never both take the last unit: the second one's condition fails
// and it updates zero rows. The CHECK constraints in schema.sql are a second line of
// defence if this code is ever wrong.
const MOVES: Record<StockMove, { set: string; guard: string }> = {
  reserve: { set: 'available = available - 1, reserved = reserved + 1', guard: 'available >= 1' },
  release: { set: 'reserved = reserved - 1, available = available + 1', guard: 'reserved >= 1' },
  commit: { set: 'reserved = reserved - 1, sold = sold + 1', guard: 'reserved >= 1' },
  sell_direct: { set: 'available = available - 1, sold = sold + 1', guard: 'available >= 1' },
};

export class InventoryInvariantError extends Error {}

async function tryMove(
  c: PoolClient,
  move: StockMove,
  productId: string,
  warehouseId: string,
): Promise<boolean> {
  const { set, guard } = MOVES[move];
  const { rowCount } = await c.query(
    `UPDATE inventory SET ${set}
     WHERE product_id = $1 AND warehouse_id = $2 AND ${guard}`,
    [productId, warehouseId],
  );
  return rowCount === 1;
}

/** Move a unit that this order already owns. Failing means our books are wrong. */
export async function mustMove(
  c: PoolClient,
  move: StockMove,
  productId: string,
  warehouseId: string,
): Promise<void> {
  if (!(await tryMove(c, move, productId, warehouseId))) {
    throw new InventoryInvariantError(
      `inventory ${productId}/${warehouseId} cannot ${move}: bucket already empty`,
    );
  }
}

/**
 * Take one unit from whichever warehouse can supply it. Returns the warehouse id, or null
 * if the product is sold out everywhere.
 *
 * The candidate list is read without locks and may be stale; it only decides the order in
 * which we try warehouses. The conditional UPDATE is what decides who gets the unit.
 * Trying the fullest warehouse first spreads concurrent buyers across rows instead of
 * queueing them all on one hot row.
 */
export async function takeFromAnyWarehouse(
  c: PoolClient,
  move: 'reserve' | 'sell_direct',
  productId: string,
): Promise<string | null> {
  for (let round = 0; round < 2; round++) {
    const { rows } = await c.query<{ warehouse_id: string }>(
      `SELECT warehouse_id FROM inventory
       WHERE product_id = $1 AND available >= 1
       ORDER BY available DESC, warehouse_id`,
      [productId],
    );
    if (rows.length === 0) return null;
    for (const { warehouse_id } of rows) {
      if (await tryMove(c, move, productId, warehouse_id)) return warehouse_id;
    }
    // Every candidate was emptied by someone else between our read and our update.
    // Re-read once in case stock was released meanwhile.
  }
  return null;
}
