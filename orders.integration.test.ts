// Integration tests against a real Postgres (started here on its own port), driving the
// order service directly. Each test sets up one dangerous situation deterministically.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

const PG_PORT = 54331;
process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${PG_PORT}/flashsale_test`;
process.env.SEED_STOCK = 'blr:4,del:3,mum:3'; // 10 units
process.env.PAYMENT_PROVIDER_URL = 'http://127.0.0.1:9'; // nothing listens: provider calls fail fast

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'flashsale-test-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: PG_PORT,
  persistent: false,
  onLog: () => {},
});

// Imported after the env is set, because config is read at import time.
let svc: typeof import('../src/services/orderService');
let db: typeof import('../src/db/pool');
let admin: typeof import('../src/services/admin');
let migrate: typeof import('../src/db/migrate');
let config: typeof import('../src/config').config;

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('flashsale_test');
  svc = await import('../src/services/orderService');
  db = await import('../src/db/pool');
  admin = await import('../src/services/admin');
  migrate = await import('../src/db/migrate');
  config = (await import('../src/config')).config;
  await migrate.migrate();
});

after(async () => {
  await db.pool.end();
  await pg.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await migrate.resetSale();
  svc.clearSoldOutHints();
  config.reservationTtlMs = 60_000;
});

let n = 0;
const reserveAs = (userId = `u${++n}`, key = `k${++n}`) =>
  svc.reserve({ userId, productId: 'phone-x', idempotencyKey: key });

async function stock() {
  const { rows } = await db.pool.query(
    `SELECT sum(available)::int AS available, sum(reserved)::int AS reserved, sum(sold)::int AS sold
     FROM inventory`,
  );
  return rows[0] as { available: number; reserved: number; sold: number };
}

async function assertInvariants() {
  const report = await admin.checkInvariants();
  assert.ok(report.ok, JSON.stringify(report.checks.filter((c) => !c.ok)));
}

async function reservedOrderId() {
  const r = await reserveAs();
  assert.equal(r.kind, 'reserved');
  return (r as { order: { id: string } }).order.id;
}

/** Reserve, then start payment. The provider is unreachable, so the order stays PAYMENT_PENDING. */
async function pendingOrderId() {
  const id = await reservedOrderId();
  const { order, providerUnavailable } = await svc.startPayment(id);
  assert.equal(order.state, 'PAYMENT_PENDING');
  assert.ok(providerUnavailable);
  return id;
}

const fakeProvider = (overrides: Partial<import('../src/services/paymentClient').PaymentProvider>) =>
  ({
    createPayment: async () => assert.fail('not expected'),
    getPaymentByOrder: async () => null,
    cancelPayment: async () => null,
    refundPayment: async () => null,
    ...overrides,
  }) as import('../src/services/paymentClient').PaymentProvider;

const pay = (orderId: string, status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED', eventId?: string) =>
  svc.applyPaymentResult({ orderId, paymentId: `pay_${orderId}`, status, source: 'webhook', eventId });

async function forcePaymentDeadlinePassed(orderId: string) {
  await db.pool.query(
    `UPDATE orders SET payment_deadline = now() - interval '1 second',
                       updated_at = now() - interval '1 minute', reconciled_at = NULL
     WHERE id = $1`,
    [orderId],
  );
}

// ---------------------------------------------------------------------------------------

test('300 concurrent buyers for 10 units: exactly 10 reservations', async () => {
  const results = await Promise.all(Array.from({ length: 300 }, () => reserveAs()));
  const reserved = results.filter((r) => r.kind === 'reserved').length;
  const soldOut = results.filter((r) => r.kind === 'sold_out').length;
  assert.equal(reserved, 10);
  assert.equal(soldOut, 290);
  assert.deepEqual(await stock(), { available: 0, reserved: 10, sold: 0 });
  await assertInvariants();
});

test('50 concurrent retries with one idempotency key create one order', async () => {
  const results = await Promise.all(Array.from({ length: 50 }, () => reserveAs('alice', 'same-key')));
  const ids = new Set(results.map((r) => (r as { order: { id: string } }).order.id));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((r) => r.kind === 'reserved').length, 1);
  assert.equal((await stock()).reserved, 1);
});

test('reusing an idempotency key for a different product is rejected', async () => {
  await reserveAs('bob', 'k-bob');
  const r = await svc.reserve({ userId: 'bob', productId: 'other', idempotencyKey: 'k-bob' });
  assert.equal(r.kind, 'idempotency_key_reused');
});

test('one unit per customer, even with concurrent attempts using different keys', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reserveAs('carol', `carol-${i}`)));
  assert.equal(results.filter((r) => r.kind === 'reserved').length, 1);
  assert.equal(results.filter((r) => r.kind === 'already_has_active_order').length, 19);
});

test('expired reservations release their stock', async () => {
  config.reservationTtlMs = 1;
  await reservedOrderId();
  await reservedOrderId();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await svc.expireReservations(), 2);
  assert.deepEqual(await stock(), { available: 10, reserved: 0, sold: 0 });
  await assertInvariants();
});

test('paying for an expired reservation is refused and frees the unit', async () => {
  config.reservationTtlMs = 1;
  const id = await reservedOrderId();
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(svc.startPayment(id), /EXPIRED/);
  assert.equal((await stock()).available, 10);
});

test('duplicate success webhooks confirm once and sell one unit', async () => {
  const id = await pendingOrderId();
  const outcomes = await Promise.all([
    ...Array.from({ length: 10 }, () => pay(id, 'SUCCEEDED', 'evt-1')), // exact redeliveries
    ...Array.from({ length: 10 }, (_, i) => pay(id, 'SUCCEEDED', `evt-other-${i}`)), // same news, new ids
  ]);
  assert.equal(outcomes.filter((o) => o.outcome === 'confirmed').length, 1);
  assert.equal((await svc.getOrder(id))!.state, 'CONFIRMED');
  assert.deepEqual(await stock(), { available: 9, reserved: 0, sold: 1 });
  await assertInvariants();
});

test('failed payment releases the unit; a later stray success does not resurrect it', async () => {
  const id = await pendingOrderId();
  assert.equal((await pay(id, 'FAILED')).outcome, 'payment_failed');
  assert.equal((await pay(id, 'SUCCEEDED')).outcome, 'no_op');
  assert.deepEqual(await stock(), { available: 10, reserved: 0, sold: 0 });
});

test('a payment in flight cannot be cancelled by the user', async () => {
  const id = await pendingOrderId();
  await assert.rejects(svc.cancel(id), /Cannot cancel/);
});

test('lost webhook: the reconciler asks the provider and confirms', async () => {
  const id = await pendingOrderId();
  await forcePaymentDeadlinePassed(id);
  const provider = fakeProvider({
    getPaymentByOrder: async (orderId) => ({ id: `pay_${orderId}`, orderId, amountCents: 1, status: 'SUCCEEDED' }),
  });
  await svc.reconcilePendingPayments(provider);
  assert.equal((await svc.getOrder(id))!.state, 'CONFIRMED');
  await assertInvariants();
});

test('crash before calling the provider: payment never started, unit released after deadline', async () => {
  const id = await pendingOrderId();
  await forcePaymentDeadlinePassed(id);
  await svc.reconcilePendingPayments(fakeProvider({ getPaymentByOrder: async () => null }));
  const order = await svc.getOrder(id);
  assert.equal(order!.state, 'EXPIRED');
  assert.equal((await stock()).available, 10);
});

test('provider down at the deadline: keep holding the unit rather than guess', async () => {
  const { ProviderUnavailableError } = await import('../src/services/paymentClient');
  const id = await pendingOrderId();
  await forcePaymentDeadlinePassed(id);
  await svc.reconcilePendingPayments(
    fakeProvider({
      getPaymentByOrder: async () => {
        throw new ProviderUnavailableError('down');
      },
    }),
  );
  assert.equal((await svc.getOrder(id))!.state, 'PAYMENT_PENDING');
  assert.equal((await stock()).reserved, 1);
});

test('late payment after expiry is honoured when stock remains', async () => {
  const id = await pendingOrderId();
  await forcePaymentDeadlinePassed(id);
  // Cancel refused: the provider says the payment is still processing.
  const pending = { id: `pay_${id}`, orderId: id, amountCents: 1, status: 'PENDING' as const };
  await svc.reconcilePendingPayments(
    fakeProvider({ getPaymentByOrder: async () => pending, cancelPayment: async () => pending }),
  );
  assert.equal((await svc.getOrder(id))!.state, 'EXPIRED');
  assert.equal((await stock()).available, 10);

  assert.equal((await pay(id)).outcome, 'late_confirmed');
  assert.deepEqual(await stock(), { available: 9, reserved: 0, sold: 1 });
  await assertInvariants();
});

test('late payment after expiry with no stock left is refunded, never oversold', async () => {
  const id = await pendingOrderId();
  await forcePaymentDeadlinePassed(id);
  const pending = { id: `pay_${id}`, orderId: id, amountCents: 1, status: 'PENDING' as const };
  await svc.reconcilePendingPayments(
    fakeProvider({ getPaymentByOrder: async () => pending, cancelPayment: async () => pending }),
  );
  // The released unit and all others are bought by other customers.
  const others = await Promise.all(Array.from({ length: 10 }, () => reserveAs()));
  assert.equal(others.filter((r) => r.kind === 'reserved').length, 10);

  // Then the late payment succeeds, and its webhook is lost. Only reconciliation sees it.
  await db.pool.query(`UPDATE orders SET reconciled_at = NULL, updated_at = now() - interval '1 minute' WHERE id = $1`, [id]);
  await svc.reconcileExpiredPayments(
    fakeProvider({ getPaymentByOrder: async () => ({ ...pending, status: 'SUCCEEDED' }) }),
  );
  assert.equal((await svc.getOrder(id))!.state, 'REFUND_PENDING');
  assert.deepEqual(await stock(), { available: 0, reserved: 10, sold: 0 });

  await db.pool.query(`UPDATE orders SET reconciled_at = NULL, updated_at = now() - interval '1 minute' WHERE id = $1`, [id]);
  await svc.processRefunds(fakeProvider({ refundPayment: async () => ({ ...pending, status: 'REFUNDED' }) }));
  assert.equal((await svc.getOrder(id))!.state, 'REFUNDED');
  await assertInvariants();
});

test('the database itself rejects any write that would break unit conservation', async () => {
  await assert.rejects(
    db.pool.query(`UPDATE inventory SET sold = sold + 1 WHERE warehouse_id = 'blr'`),
    /inventory_conservation/,
  );
  await assert.rejects(
    db.pool.query(`UPDATE inventory SET available = available - 100, sold = sold + 100 WHERE warehouse_id = 'blr'`),
    /check constraint/,
  );
});
