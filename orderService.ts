import type { PoolClient } from 'pg';
import { config } from '../config';
import { isUniqueViolation, pool, tx, type Db } from '../db/pool';
import { stockMoveFor, type OrderState } from '../domain/stateMachine';
import { maybeCrash } from '../faults';
import { mustMove, takeFromAnyWarehouse } from './inventory';
import { paymentProvider, ProviderUnavailableError, type ProviderPayment } from './paymentClient';

export interface OrderRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  product_id: string;
  warehouse_id: string | null;
  state: OrderState;
  amount_cents: number;
  payment_id: string | null;
  expires_at: Date;
  payment_deadline: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

class OutOfStockError extends Error {}

// ---------------------------------------------------------------------------------------
// Sold-out hint: once a process sees the product sold out, it answers further attempts
// without opening a transaction for a short while. Without it, thousands of losing buyers
// would each take a row lock on the hot inventory rows just to be told "no".
// ---------------------------------------------------------------------------------------
const soldOutUntil = new Map<string, number>();
const isHintedSoldOut = (productId: string) => (soldOutUntil.get(productId) ?? 0) > Date.now();
export const clearSoldOutHints = () => soldOutUntil.clear();

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

async function lockOrder(c: PoolClient, orderId: string) {
  const { rows } = await c.query<OrderRow & { hold_expired: boolean; payment_overdue: boolean }>(
    `SELECT *, expires_at <= now() AS hold_expired,
            coalesce(payment_deadline <= now(), false) AS payment_overdue
     FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  return rows[0] ?? null;
}

export async function getOrder(orderId: string, db: Db = pool): Promise<OrderRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const { rows } = await db.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId]);
  return rows[0] ?? null;
}

async function findByIdempotencyKey(db: Db, userId: string, key: string) {
  const { rows } = await db.query<OrderRow>(
    'SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2',
    [userId, key],
  );
  return rows[0] ?? null;
}

/**
 * Move a locked order to a new state, applying the stock movement the state machine
 * prescribes and writing an audit event. The caller must hold the row lock on the order.
 */
async function transition(
  c: PoolClient,
  order: OrderRow,
  to: OrderState,
  reason: string,
): Promise<OrderRow> {
  const move = stockMoveFor(order.state, to); // throws on an illegal transition
  let warehouseId = order.warehouse_id;
  if (move === 'sell_direct') {
    warehouseId = await takeFromAnyWarehouse(c, 'sell_direct', order.product_id);
    if (!warehouseId) throw new OutOfStockError();
  } else if (move) {
    await mustMove(c, move, order.product_id, warehouseId!);
  }

  const { rows } = await c.query<OrderRow>(
    `UPDATE orders
     SET state = $2,
         warehouse_id = $3,
         payment_deadline = CASE WHEN $2 = 'PAYMENT_PENDING'
                                 THEN now() + $5 * interval '1 millisecond'
                                 ELSE payment_deadline END,
         updated_at = now(),
         version = version + 1
     WHERE id = $1 AND state = $4
     RETURNING *`,
    [order.id, to, warehouseId, order.state, config.paymentTimeoutMs],
  );
  if (rows.length !== 1) {
    throw new Error(`order ${order.id} changed under a lock (expected ${order.state})`);
  }
  await c.query(
    'INSERT INTO order_events (order_id, from_state, to_state, reason) VALUES ($1, $2, $3, $4)',
    [order.id, order.state, to, reason],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------------------
// 1. Reserve
// ---------------------------------------------------------------------------------------

export type ReserveResult =
  | { kind: 'reserved'; order: OrderRow }
  | { kind: 'existing'; order: OrderRow }
  | { kind: 'sold_out' }
  | { kind: 'already_has_active_order'; order: OrderRow | null }
  | { kind: 'idempotency_key_reused' }
  | { kind: 'unknown_product' };

function replay(existing: OrderRow, productId: string): ReserveResult {
  // Same key, different request body: the client has a bug. Refuse rather than guess.
  if (existing.product_id !== productId) return { kind: 'idempotency_key_reused' };
  return { kind: 'existing', order: existing };
}

/** Thrown inside the transaction to roll it back and return a result instead. */
class Abort {
  constructor(readonly result: ReserveResult) {}
}

export async function reserve(input: {
  userId: string;
  productId: string;
  idempotencyKey: string;
}): Promise<ReserveResult> {
  const { userId, productId, idempotencyKey } = input;

  if (isHintedSoldOut(productId)) {
    // Even on the fast path, a retry of a request that did succeed must get its order back.
    const existing = await findByIdempotencyKey(pool, userId, idempotencyKey);
    return existing ? replay(existing, productId) : { kind: 'sold_out' };
  }

  try {
    const result = await tx<ReserveResult>(async (c) => {
      const product = await c.query<{ price_cents: number }>(
        'SELECT price_cents FROM products WHERE id = $1',
        [productId],
      );
      if (product.rowCount === 0) {
        const existing = await findByIdempotencyKey(c, userId, idempotencyKey);
        return existing ? replay(existing, productId) : { kind: 'unknown_product' };
      }

      // Claim the idempotency key first. A concurrent duplicate blocks on the unique index
      // until we commit (then sees our order) or roll back (then proceeds itself).
      const inserted = await c.query<OrderRow>(
        `INSERT INTO orders (user_id, idempotency_key, product_id, state, amount_cents, expires_at)
         VALUES ($1, $2, $3, 'RESERVED', $4, now() + $5 * interval '1 millisecond')
         ON CONFLICT (user_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [userId, idempotencyKey, productId, product.rows[0].price_cents, config.reservationTtlMs],
      );
      if (inserted.rowCount === 0) {
        return replay((await findByIdempotencyKey(c, userId, idempotencyKey))!, productId);
      }

      const warehouseId = await takeFromAnyWarehouse(c, 'reserve', productId);
      if (!warehouseId) throw new Abort({ kind: 'sold_out' });

      const { rows } = await c.query<OrderRow>(
        'UPDATE orders SET warehouse_id = $2 WHERE id = $1 RETURNING *',
        [inserted.rows[0].id, warehouseId],
      );
      await c.query(
        `INSERT INTO order_events (order_id, from_state, to_state, reason)
         VALUES ($1, NULL, 'RESERVED', $2)`,
        [rows[0].id, `reserved_from:${warehouseId}`],
      );
      return { kind: 'reserved', order: rows[0] };
    });
    if (result.kind === 'reserved') maybeCrash('reserve_after_commit');
    return result;
  } catch (err) {
    if (err instanceof Abort) {
      if (err.result.kind === 'sold_out') {
        soldOutUntil.set(productId, Date.now() + config.soldOutCacheMs);
      }
      return err.result;
    }
    if (isUniqueViolation(err, 'orders_one_active_per_user')) {
      const { rows } = await pool.query<OrderRow>(
        `SELECT * FROM orders WHERE user_id = $1 AND product_id = $2
         AND state IN ('RESERVED', 'PAYMENT_PENDING', 'CONFIRMED')`,
        [userId, productId],
      );
      return { kind: 'already_has_active_order', order: rows[0] ?? null };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------
// 2. Pay
// ---------------------------------------------------------------------------------------

export interface PayResult {
  order: OrderRow;
  payment: ProviderPayment | null;
  providerUnavailable: boolean;
}

/**
 * Move RESERVED -> PAYMENT_PENDING, then ask the provider to charge. Safe to call again:
 * a retry on a PAYMENT_PENDING order re-sends the (idempotent) create-payment request.
 *
 * The state change commits *before* we call the provider, so the provider can never hold
 * a payment for an order we still consider merely RESERVED (and might expire under it).
 */
export async function startPayment(orderId: string): Promise<PayResult> {
  const order = await tx(async (c) => {
    const o = await lockOrder(c, orderId);
    if (!o) throw new DomainError('ORDER_NOT_FOUND', 404, 'Order not found');
    if (o.state === 'RESERVED') {
      if (o.hold_expired) return transition(c, o, 'EXPIRED', 'reservation_ttl_at_payment');
      return transition(c, o, 'PAYMENT_PENDING', 'payment_started');
    }
    return o;
  });

  if (order.state !== 'PAYMENT_PENDING') {
    if (order.state === 'CONFIRMED') return { order, payment: null, providerUnavailable: false };
    throw new DomainError('ORDER_NOT_PAYABLE', 409, `Order is ${order.state}`);
  }

  maybeCrash('pay_before_provider_call');
  try {
    const payment = await paymentProvider.createPayment(order.id, order.amount_cents);
    maybeCrash('pay_after_provider_call');
    await pool.query('UPDATE orders SET payment_id = $2 WHERE id = $1 AND payment_id IS NULL', [
      order.id,
      payment.id,
    ]);
    return { order: { ...order, payment_id: payment.id }, payment, providerUnavailable: false };
  } catch (err) {
    // Timeout or provider down: we do not know whether a payment exists. The order stays
    // PAYMENT_PENDING and the reconciler will find out.
    if (err instanceof ProviderUnavailableError) {
      return { order, payment: null, providerUnavailable: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------
// 3. Payment outcome (webhook or reconciler)
// ---------------------------------------------------------------------------------------

export type PaymentOutcome =
  | 'confirmed'
  | 'late_confirmed'
  | 'refund_pending'
  | 'payment_failed'
  | 'duplicate_event'
  | 'unknown_order'
  | 'no_op';

export async function applyPaymentResult(input: {
  orderId: string;
  paymentId: string;
  status: 'SUCCEEDED' | 'FAILED';
  source: 'webhook' | 'reconciler';
  eventId?: string;
}): Promise<{ outcome: PaymentOutcome; state?: OrderState }> {
  const { orderId, paymentId, status, source, eventId } = input;

  return tx(async (c) => {
    // Inbox dedupe: the provider delivers at-least-once. Recording the event id in the
    // same transaction as its effect means "processed" and "recorded" commit together.
    if (eventId) {
      const fresh = await c.query(
        `INSERT INTO payment_events (event_id, order_id, payment_id, status)
         VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING`,
        [eventId, orderId, paymentId, status],
      );
      if (fresh.rowCount === 0) return { outcome: 'duplicate_event' as const };
    }

    const o = await lockOrder(c, orderId);
    if (!o) return { outcome: 'unknown_order' as const };
    await c.query(
      'UPDATE orders SET payment_id = coalesce(payment_id, $2), payment_resolved = true WHERE id = $1',
      [orderId, paymentId],
    );

    let result: { outcome: PaymentOutcome; state?: OrderState };
    if (status === 'FAILED') {
      result =
        o.state === 'PAYMENT_PENDING'
          ? {
              outcome: 'payment_failed',
              state: (await transition(c, o, 'PAYMENT_FAILED', `payment_failed:${source}`)).state,
            }
          : { outcome: 'no_op', state: o.state };
    } else if (o.state === 'PAYMENT_PENDING') {
      const updated = await transition(c, o, 'CONFIRMED', `payment_succeeded:${source}`);
      result = { outcome: 'confirmed', state: updated.state };
    } else if (o.state === 'EXPIRED') {
      result = await handleLatePayment(c, o, source);
    } else {
      // CONFIRMED (duplicate success), REFUND_*, or a state with no payment in flight.
      result = { outcome: 'no_op', state: o.state };
    }

    if (source === 'webhook') maybeCrash('webhook_before_commit');
    return result;
  });
}

/**
 * Money arrived for an order whose hold already lapsed and whose unit went back to the
 * pool. If a unit is still available we honour the purchase; otherwise we refund.
 * We never take a unit from someone else's reservation to do this.
 */
async function handleLatePayment(c: PoolClient, o: OrderRow, source: string) {
  await c.query('SAVEPOINT late_payment');
  try {
    const updated = await transition(c, o, 'CONFIRMED', `late_payment_succeeded:${source}`);
    await c.query('RELEASE SAVEPOINT late_payment');
    return { outcome: 'late_confirmed' as const, state: updated.state };
  } catch (err) {
    // No stock left, or the user has since bought one through another order.
    if (err instanceof OutOfStockError || isUniqueViolation(err, 'orders_one_active_per_user')) {
      await c.query('ROLLBACK TO SAVEPOINT late_payment');
      const updated = await transition(c, o, 'REFUND_PENDING', 'late_payment_no_stock');
      return { outcome: 'refund_pending' as const, state: updated.state };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------
// 4. Cancel
// ---------------------------------------------------------------------------------------

export async function cancel(orderId: string): Promise<OrderRow> {
  return tx(async (c) => {
    const o = await lockOrder(c, orderId);
    if (!o) throw new DomainError('ORDER_NOT_FOUND', 404, 'Order not found');
    if (o.state === 'CANCELLED') return o;
    if (o.state !== 'RESERVED') {
      // Once payment has started, money may be moving; only the payment outcome or the
      // payment deadline may end the order.
      throw new DomainError('ORDER_NOT_CANCELLABLE', 409, `Cannot cancel an order in ${o.state}`);
    }
    return transition(c, o, 'CANCELLED', 'user_cancelled');
  });
}

// ---------------------------------------------------------------------------------------
// 5. Background jobs (see jobs/index.ts). Each is safe to run in every process at once.
// ---------------------------------------------------------------------------------------

/** Release stock held by reservations whose TTL passed. */
export async function expireReservations(batch = config.jobBatchSize): Promise<number> {
  return tx(async (c) => {
    // SKIP LOCKED: several processes run this job; each takes a disjoint batch, and none
    // waits on an order a buyer is currently paying for.
    const { rows } = await c.query<OrderRow>(
      `SELECT * FROM orders
       WHERE state = 'RESERVED' AND expires_at <= now()
       ORDER BY expires_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    // Release in warehouse order, so two sweepers locking several inventory rows always
    // take those locks in the same order and cannot deadlock each other.
    rows.sort((a, b) => (a.warehouse_id ?? '').localeCompare(b.warehouse_id ?? ''));
    for (const o of rows) await transition(c, o, 'EXPIRED', 'reservation_ttl');
    return rows.length;
  });
}

async function expirePendingPayment(
  orderId: string,
  reason: string,
  paymentResolved: boolean,
): Promise<void> {
  await tx(async (c) => {
    const o = await lockOrder(c, orderId);
    if (o?.state !== 'PAYMENT_PENDING') return;
    await transition(c, o, 'EXPIRED', reason);
    if (paymentResolved) {
      await c.query('UPDATE orders SET payment_resolved = true WHERE id = $1', [orderId]);
    }
  });
}

/**
 * Resolve PAYMENT_PENDING orders that have not heard from the provider: lost webhooks,
 * timeouts when creating the payment, crashes between steps.
 */
export async function reconcilePendingPayments(
  provider = paymentProvider,
  batch = config.jobBatchSize,
): Promise<number> {
  // Claim a batch by stamping reconciled_at so that concurrent reconcilers in other
  // processes pick different orders and each order is polled at most once per interval.
  const { rows } = await pool.query<{ id: string; overdue: boolean }>(
    `UPDATE orders SET reconciled_at = now()
     WHERE id IN (
       SELECT id FROM orders
       WHERE state = 'PAYMENT_PENDING'
         AND coalesce(reconciled_at, updated_at) <= now() - $1 * interval '1 millisecond'
       ORDER BY updated_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED)
     RETURNING id, payment_deadline <= now() AS overdue`,
    [config.reconcileAfterMs, batch],
  );

  for (const { id, overdue } of rows) {
    try {
      let payment = await provider.getPaymentByOrder(id);
      if (isFinal(payment)) {
        await settleFromProvider(id, payment!);
        continue;
      }
      if (!overdue) continue; // still within the payment window: keep waiting

      if (payment?.status === 'PENDING') {
        // Deadline passed: try to void the payment before giving the unit back.
        payment = (await provider.cancelPayment(payment.id)) ?? payment;
        if (isFinal(payment)) {
          await settleFromProvider(id, payment);
          continue;
        }
      }
      // Payment cancelled, never created, or the provider refused to cancel it. Release
      // the unit now. If money does arrive later, handleLatePayment deals with it.
      await expirePendingPayment(
        id,
        payment ? `payment_deadline:${payment.status.toLowerCase()}` : 'payment_never_started',
        payment?.status !== 'PENDING',
      );
    } catch (err) {
      // Provider unreachable: we cannot know if the customer paid, so we keep holding the
      // unit rather than risk selling it twice. Retried next interval.
      if (!(err instanceof ProviderUnavailableError)) throw err;
    }
  }
  return rows.length;
}

/**
 * Watch orders that expired while their payment was still open at the provider (cancel
 * refused, or provider unsure). If the payment later succeeds and its webhook is lost too,
 * this is what notices the charge and confirms or refunds the order.
 */
export async function reconcileExpiredPayments(
  provider = paymentProvider,
  batch = config.jobBatchSize,
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE orders SET reconciled_at = now()
     WHERE id IN (
       SELECT id FROM orders
       WHERE state = 'EXPIRED' AND payment_deadline IS NOT NULL AND NOT payment_resolved
         AND coalesce(reconciled_at, updated_at) <= now() - $1 * interval '1 millisecond'
       ORDER BY updated_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED)
     RETURNING id`,
    [config.reconcileAfterMs, batch],
  );
  for (const { id } of rows) {
    try {
      let payment = await provider.getPaymentByOrder(id);
      if (payment?.status === 'PENDING') payment = (await provider.cancelPayment(payment.id)) ?? payment;
      if (isFinal(payment)) {
        await settleFromProvider(id, payment!);
      } else if (payment?.status !== 'PENDING') {
        // Cancelled, or never existed: nothing more can happen to this payment.
        await pool.query('UPDATE orders SET payment_resolved = true WHERE id = $1', [id]);
      }
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) throw err;
    }
  }
  return rows.length;
}

const isFinal = (p: ProviderPayment | null) => p?.status === 'SUCCEEDED' || p?.status === 'FAILED';

function settleFromProvider(orderId: string, payment: ProviderPayment) {
  return applyPaymentResult({
    orderId,
    paymentId: payment.id,
    status: payment.status as 'SUCCEEDED' | 'FAILED',
    source: 'reconciler',
  });
}

/** Refund customers whose late payment could not be honoured. */
export async function processRefunds(
  provider = paymentProvider,
  batch = config.jobBatchSize,
): Promise<number> {
  const { rows } = await pool.query<{ id: string; payment_id: string }>(
    `UPDATE orders SET reconciled_at = now()
     WHERE id IN (
       SELECT id FROM orders
       WHERE state = 'REFUND_PENDING'
         AND coalesce(reconciled_at, updated_at) <= now() - $1 * interval '1 millisecond'
       LIMIT $2
       FOR UPDATE SKIP LOCKED)
     RETURNING id, payment_id`,
    [config.jobIntervalMs, batch],
  );
  for (const { id, payment_id } of rows) {
    try {
      const payment = await provider.refundPayment(payment_id);
      if (payment?.status !== 'REFUNDED') continue;
      await tx(async (c) => {
        const o = await lockOrder(c, id);
        if (o?.state === 'REFUND_PENDING') await transition(c, o, 'REFUNDED', 'refund_completed');
      });
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) throw err;
    }
  }
  return rows.length;
}
