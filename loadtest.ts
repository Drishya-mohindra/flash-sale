// Flash-sale load test: thousands of buyers hit the sale at once, behaving like real
// clients (retries with the same Idempotency-Key, double-taps, abandoned carts). When the
// dust settles it checks that the system kept its promises.
//
//   npm run loadtest                       10,000 buyers, then a 2,000-buyer second wave
//   BUYERS=20000 CONNECTIONS=512 npm run loadtest
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Agent, fetch } from 'undici';

const env = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const PSP = process.env.PSP_URL ?? 'http://localhost:4000';
const BUYERS = env('BUYERS', 10_000);
const WAVE2 = env('WAVE2', 2_000);
const ABANDON_RATE = env('ABANDON_RATE', 0.2); // reserve, then never pay
const DUPLICATE_RATE = env('DUPLICATE_RATE', 0.1); // same request sent twice at once
const DOUBLE_TAP_RATE = env('DOUBLE_TAP_RATE', 0.05); // same user, second purchase attempt
const DOUBLE_PAY_RATE = env('DOUBLE_PAY_RATE', 0.1); // pay clicked twice
const SETTLE_TIMEOUT_MS = env('SETTLE_TIMEOUT_MS', 150_000);
// Includes time spent queued in the client pool, so it must cover the slowest tail.
const REQUEST_TIMEOUT_MS = env('REQUEST_TIMEOUT_MS', 30_000);

// A bounded connection pool: requests beyond it queue client-side, as with a real fleet of
// clients behind a load balancer.
const dispatcher = new Agent({ connections: env('CONNECTIONS', 256), keepAliveTimeout: 10_000 });

type Json = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chance = (p: number) => Math.random() < p;

const counts: Record<string, number> = {};
const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
const reserveLatencies: number[] = [];

async function request(method: string, url: string, body?: Json, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method,
    dispatcher,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
}

/**
 * Like a real client: on a network error or 503, retry the same request, same key. After
 * the last attempt the buyer gives up (status 0) instead of failing the whole run; the
 * server must still end up consistent, which the verdict checks.
 */
async function withRetries(fn: () => ReturnType<typeof request>, label: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fn();
      if (res.status !== 503 || attempt >= 8) return res;
      bump(`${label}: 503 overloaded (retried)`);
    } catch {
      if (attempt >= 8) return { status: 0, body: { error: 'GAVE_UP' } as Json };
      bump(`${label}: network error (retried)`); // e.g. the worker serving it crashed
    }
    await sleep(100 * 2 ** Math.min(attempt, 5) * (0.5 + Math.random()));
  }
}

const reserve = (userId: string, key: string) =>
  withRetries(() => request('POST', `${BASE}/api/orders`, { userId }, { 'Idempotency-Key': key }), 'reserve');
const pay = (orderId: string) =>
  withRetries(() => request('POST', `${BASE}/api/orders/${orderId}/pay`), 'pay');

async function buyer(userId: string, wave: string, abandonRate: number) {
  const key = randomUUID();
  const t0 = performance.now();
  const attempts = [reserve(userId, key)];
  const isDuplicate = chance(DUPLICATE_RATE);
  if (isDuplicate) attempts.push(reserve(userId, key));
  const isDoubleTap = chance(DOUBLE_TAP_RATE);
  if (isDoubleTap) attempts.push(reserve(userId, randomUUID()));

  const [first, ...others] = await Promise.all(attempts);
  reserveLatencies.push(performance.now() - t0);
  bump(`${wave} reserve -> ${first.status} ${first.body.result ?? first.body.error}`);

  if (isDuplicate) {
    const dup = others.shift()!;
    const a = first.body.order?.orderId;
    const b = dup.body.order?.orderId;
    if (first.status === 0 || dup.status === 0) bump('duplicate request -> client gave up, not compared');
    else if (a === b) bump('duplicate request -> same order (idempotent)');
    // A sold-out attempt leaves no record, so its twin may still win a unit released in
    // between. Still one order: only two different order ids would be a violation.
    else if (!a || !b) bump('duplicate request -> one sold out, one reserved (still one order)');
    else {
      bump('DUPLICATE REQUEST -> DIFFERENT ORDERS');
      console.log(`  mismatch for ${userId}:`, JSON.stringify({ first, dup }));
    }
  }
  if (isDoubleTap) {
    const tap = others.shift()!;
    const ordersHeld = [first, tap].filter((r) => r.status === 201).length;
    bump(ordersHeld <= 1 ? 'double tap -> at most one order' : 'DOUBLE TAP -> TWO ORDERS');
  }

  const orderId = first.body.order?.orderId;
  if (!orderId || first.body.order.state !== 'RESERVED') return;
  if (chance(abandonRate)) return bump(`${wave} abandoned cart`);

  const pays = [pay(orderId)];
  if (chance(DOUBLE_PAY_RATE)) pays.push(pay(orderId));
  const [p] = await Promise.all(pays);
  bump(`${wave} pay -> ${p.status} ${p.body.order?.state ?? p.body.error}`);
}

/** Admin reads are retried: under load or chaos a single one may time out or hit a dying worker. */
async function adminGet(path: string): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await request('GET', `${BASE}${path}`)).body;
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(1000);
    }
  }
}
const stats = () => adminGet('/admin/stats');

async function waitUntilSettled(label: string) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < SETTLE_TIMEOUT_MS) {
    const s = await stats();
    const o = s.orders;
    const open =
      (o.RESERVED ?? 0) + (o.PAYMENT_PENDING ?? 0) + (o.REFUND_PENDING ?? 0) + (s.provider?.byStatus?.PENDING ?? 0);
    const line = `  ${label}: RESERVED=${o.RESERVED ?? 0} PAYMENT_PENDING=${o.PAYMENT_PENDING ?? 0} REFUND_PENDING=${o.REFUND_PENDING ?? 0} provider PENDING=${s.provider?.byStatus?.PENDING ?? 0}`;
    if (line !== last) console.log(line);
    last = line;
    if (open === 0) return;
    await sleep(1000);
  }
  console.log(`  ${label}: did not settle within ${SETTLE_TIMEOUT_MS / 1000}s`);
}

function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]?.toFixed(0);
}

// ---------------------------------------------------------------------------------------

if (process.env.RESET !== '0') {
  await request('POST', `${BASE}/admin/reset`);
  await request('POST', `${PSP}/admin/reset`);
}
const initial = await stats();
const unitsExist = initial.inventory.reduce((s: number, w: Json) => s + w.total, 0);
console.log(`\nFlash sale: ${unitsExist} units, ${BUYERS} buyers at once, then ${WAVE2} more\n`);

const t0 = performance.now();
await Promise.all(Array.from({ length: BUYERS }, (_, i) => buyer(`user-${i}`, 'wave1', ABANDON_RATE)));
const wave1Ms = performance.now() - t0;
console.log(`wave 1 done in ${(wave1Ms / 1000).toFixed(1)}s (${Math.round(BUYERS / (wave1Ms / 1000))} buyers/s)`);

console.log('waiting for abandoned reservations to expire and payments to settle…');
await waitUntilSettled('wave 1');

if (WAVE2 > 0) {
  console.log(`\nwave 2: ${WAVE2} late buyers go after the units that came back`);
  await Promise.all(Array.from({ length: WAVE2 }, (_, i) => buyer(`late-user-${i}`, 'wave2', 0)));
  await waitUntilSettled('wave 2');
}

// ---------------------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------------------
const final = await stats();
const invariants = await adminGet('/admin/invariants');
const o = final.orders;
const psp = final.provider ?? { byStatus: {} };
const confirmed = o.CONFIRMED ?? 0;
const sold = final.inventory.reduce((s: number, w: Json) => s + w.sold, 0);
const charged = psp.byStatus.SUCCEEDED ?? 0; // money currently kept by the merchant
const refunded = psp.byStatus.REFUNDED ?? 0;

console.log('\nResponses');
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${String(v).padStart(6)}  ${k}`);

const sortedLat = reserveLatencies.sort((a, b) => a - b);
console.log(`\nReserve latency, end to end (incl. queueing in the client connection pool and retries): p50 ${pct(sortedLat, 50)}ms  p95 ${pct(sortedLat, 95)}ms  p99 ${pct(sortedLat, 99)}ms`);

console.log('\nFinal order states');
for (const [k, v] of Object.entries(o)) console.log(`  ${String(v).padStart(6)}  ${k}`);
console.log(
  `\nPayment provider: ${psp.payments} payments, ${JSON.stringify(psp.byStatus)}, ` +
    `${psp.duplicateWebhooks} duplicate webhooks, ${psp.lostWebhooks} lost webhooks, ${psp.slowResponses} slow responses`,
);

const verdicts: Array<[string, boolean, string]> = [
  ['Never sold more units than exist', confirmed <= unitsExist && sold <= unitsExist, `${confirmed} confirmed / ${unitsExist} units`],
  ['Every confirmed order has a sold unit', confirmed === sold, `${confirmed} confirmed, ${sold} sold`],
  ['Every kept payment has a confirmed order', charged === confirmed, `${charged} payments kept, ${confirmed} confirmed orders`],
  ['Every unfulfillable payment was refunded', refunded === (o.REFUNDED ?? 0), `${refunded} refunded at provider, ${o.REFUNDED ?? 0} REFUNDED orders`],
  ['No duplicate request created a second order', !counts['DUPLICATE REQUEST -> DIFFERENT ORDERS'], ''],
  ['No customer holds two orders', !counts['DOUBLE TAP -> TWO ORDERS'], ''],
  ['Database invariants hold', invariants.ok, invariants.checks?.filter((c: Json) => !c.ok).map((c: Json) => c.name).join(', ') || 'all checks pass'],
];
console.log('\nVerdict');
for (const [name, ok, detail] of verdicts) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
const allOk = verdicts.every(([, ok]) => ok);
console.log(allOk ? '\nALL CHECKS PASSED\n' : '\nSOME CHECKS FAILED\n');
await dispatcher.close();
process.exit(allOk ? 0 : 1);
