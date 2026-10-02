# Flash-Sale Distributed Inventory

**Techcora Advanced System Design Challenge, Problem Statement 4.**
100 smartphones, 10,000 buyers, a few seconds. The system must never sell a unit that
doesn't exist, even when requests are duplicated, payments time out, webhooks are lost or
repeated, and processes crash halfway through a purchase.

```
Flash sale: 100 units, 10000 buyers at once, then 2000 more        (CHAOS=1 run)
  7 worker crashes · 49 duplicate webhooks · 12 lost webhooks · 13 slow provider responses

  PASS  Never sold more units than exist  (98 confirmed / 100 units)
  PASS  Every confirmed order has a sold unit  (98 confirmed, 98 sold)
  PASS  Every kept payment has a confirmed order  (98 payments kept, 98 confirmed orders)
  PASS  Every unfulfillable payment was refunded
  PASS  No duplicate request created a second order
  PASS  No customer holds two orders
  PASS  Database invariants hold
```

---

## Contents

1. [Running it](#1-running-it)
2. [The problem and its domain](#2-the-problem-and-its-domain)
3. [Architecture](#3-architecture)
4. [The order state machine](#4-the-order-state-machine)
5. [How "never oversell" is guaranteed](#5-how-never-oversell-is-guaranteed)
6. [Failures and edge cases](#6-failures-and-edge-cases)
7. [Technical decisions and why](#7-technical-decisions-and-why)
8. [Trade-offs and limitations](#8-trade-offs-and-limitations)
9. [What I would do with more time](#9-what-i-would-do-with-more-time)
10. [Project layout and API](#10-project-layout-and-api)

---

## 1. Running it

Requirements: **Node.js 20+**. Nothing else. Postgres is installed through npm
(`embedded-postgres`, real Postgres binaries) so no Docker or system install is needed.

```bash
npm install
npm run up          # Postgres + mock payment provider + order service (4 worker processes)
```

Open the live dashboard at **http://localhost:3000/dashboard**, then in a second terminal:

```bash
npm run loadtest    # 10,000 concurrent buyers, then a 2,000-buyer second wave; prints PASS/FAIL
npm test            # 20 unit + integration tests against a real Postgres
```

Chaos mode: workers crash at injected points, and the payment provider loses webhooks,
duplicates them, answers slowly, settles late and refuses cancellations.

```bash
CHAOS=1 npm run up
npm run loadtest
```

Using Docker Postgres instead: `docker compose up -d`, then
`DATABASE_URL=postgres://postgres:postgres@localhost:5432/flashsale npm run up`.

Useful knobs (env vars): `WORKERS`, `RESERVATION_TTL_MS` (15s), `PAYMENT_TIMEOUT_MS` (20s),
`SEED_STOCK` (`blr:50,del:30,mum:20`), `BUYERS`, `WAVE2`, `ABANDON_RATE`, `FAULTS`,
`PSP_*` (see `payment-provider/server.ts`).

Try it by hand:

```bash
curl -X POST localhost:3000/api/orders -H 'content-type: application/json' \
     -H 'Idempotency-Key: 1f6c' -d '{"userId":"alice"}'
curl -X POST localhost:3000/api/orders/<orderId>/pay
curl localhost:3000/api/orders/<orderId>
curl localhost:3000/admin/invariants
```

---

## 2. The problem and its domain

A flash sale is an extreme case of a normal checkout: **demand is 100x supply and it
all arrives in the first seconds.** That changes what is hard.

| In a normal shop | In a flash sale |
|---|---|
| Stock contention is rare | Every request contends for the same few database rows |
| A slow payment just waits | A unit held by a slow payer is a unit someone else could buy |
| A retry is an occasional event | Users mash the button; mobile networks drop responses; clients retry |
| Overselling by one is an apology email | Overselling 100 phones is a headline and a legal problem |

**Who experiences the problem**
- *Buyers* want a fast, honest answer: "you got one, pay within N seconds" or "sold out".
  They must never be charged without getting a phone, or charged twice.
- *The business* must never promise more units than exist, and wants every unit sold:
  units held by people who never pay must come back to the pool.
- *Operations* need to know the books are right at any instant, during and after the sale.

**How the real domain works.** Checkout is two separate commitments:
1. **Reserve** a unit (seconds, inside our system).
2. **Take payment** through an external payment provider (seconds to minutes, outside our
   control). The provider tells us the outcome later with a webhook, delivered
   *at least once*: it may arrive twice, late, or never.

The gap between the two is where everything goes wrong. A unit is "ours" (held) while
money is "theirs" (in flight), and either side can fail independently.

**Constraints that drive the design**
- Absolute: units sold ≤ units that exist.
- Every successful charge must end in a confirmed order or a refund.
- At-least-once everywhere (client retries, webhooks): every operation must be idempotent.
- Any process can crash at any line. Recovery must not need a human.
- One unit per customer (common flash-sale fairness rule; also limits bots).

---

## 3. Architecture

```mermaid
flowchart LR
    C["10,000 buyers<br/>load test clients"] -->|"HTTP + Idempotency-Key"| LB

    subgraph OS["Order service - Node cluster, stateless"]
      LB(("shared port :3000")) --> W1["worker 1"]
      LB --> W2["worker 2"]
      LB --> W3["worker 3"]
      LB --> W4["worker 4"]
    end

    W1 & W2 & W3 & W4 -->|"transactions<br/>row locks"| PG[("Postgres<br/>source of truth")]
    W1 & W2 & W3 & W4 -->|"create / query /<br/>cancel / refund"| PSP["Payment provider<br/>mock, separate process"]
    PSP -.->|"signed webhook<br/>at-least-once, retried"| LB

    subgraph JOBS["in every worker"]
      J1["expiry sweeper"]
      J2["payment reconciler"]
      J3["expired-payment watcher"]
      J4["refund worker"]
    end
    J1 & J2 & J3 & J4 --> PG
    J2 & J3 & J4 --> PSP
```

| Component | Responsibility |
|---|---|
| **Order service** (`src/`) | Buyer API, webhook endpoint, background jobs. Runs as N identical, stateless processes that share nothing but the database, so it scales and survives crashes like N containers behind a load balancer. |
| **Postgres** | Single source of truth for stock and order state. Enforces the critical invariants itself with CHECK constraints and unique indexes. |
| **Payment provider** (`payment-provider/`) | Separate process imitating a real payment provider: idempotent create-payment, async signed webhooks with retries. It can misbehave on demand (lost, duplicate or late webhooks, slow responses, refused cancels). |
| **Expiry sweeper** | Releases units held by reservations that passed their TTL. |
| **Payment reconciler** | For orders waiting on payment with no webhook, asks the provider directly. Past the payment deadline it cancels the payment and releases the unit. |
| **Expired-payment watcher** | Keeps watching orders that expired while their payment was still open at the provider, so a late charge with a lost webhook is still caught. |
| **Refund worker** | Refunds customers whose late payment could not be honoured. |
| **Dashboard** (`/dashboard`) | Live unit map per warehouse, a demand funnel (every purchase request by outcome, including the thousands turned away), sell-through over the whole sale against requests per second (rebuilt from the audit log, so it survives a refresh), orders by lifecycle stage, payment ledger (our records vs the provider's), recent transitions. Invariant checks sit behind the status pill in the header. |

**Domain entities**: `products`, `warehouses`, `inventory` (one row per product × warehouse
with `available / reserved / sold` buckets), `orders` (the state machine),
`order_events` (append-only audit log of every transition), `payment_events` (webhook
inbox used for deduplication). See [`src/db/schema.sql`](src/db/schema.sql).

**Purchase flow**

```mermaid
sequenceDiagram
    participant B as Buyer
    participant S as Order service
    participant DB as Postgres
    participant P as Payment provider
    B->>S: POST /api/orders (Idempotency-Key)
    S->>DB: BEGIN, insert order (claims key), take 1 unit (conditional UPDATE), COMMIT
    S-->>B: 201 RESERVED (expires in 15s)
    B->>S: POST /orders/:id/pay
    S->>DB: RESERVED → PAYMENT_PENDING (commit first)
    S->>P: create payment (idempotent on orderId)
    S-->>B: 202 PAYMENT_PENDING
    P-->>S: webhook SUCCEEDED (maybe twice, maybe never)
    S->>DB: BEGIN, record event id (dedupe), PAYMENT_PENDING → CONFIRMED, reserved → sold, COMMIT
    Note over S,P: no webhook after 3s? The reconciler asks P directly
```

---

## 4. The order state machine

```mermaid
stateDiagram-v2
    [*] --> RESERVED: reserve (available → reserved)
    RESERVED --> PAYMENT_PENDING: pay
    RESERVED --> EXPIRED: TTL passed (release)
    RESERVED --> CANCELLED: user cancels (release)
    PAYMENT_PENDING --> CONFIRMED: payment succeeded (reserved → sold)
    PAYMENT_PENDING --> PAYMENT_FAILED: payment failed (release)
    PAYMENT_PENDING --> EXPIRED: deadline passed, payment cancelled / never started (release)
    EXPIRED --> CONFIRMED: late payment, unit still available (available → sold)
    EXPIRED --> REFUND_PENDING: late payment, no unit left
    REFUND_PENDING --> REFUNDED: refund done
    CONFIRMED --> [*]
    CANCELLED --> [*]
    PAYMENT_FAILED --> [*]
    REFUNDED --> [*]
```

The problem statement's `AVAILABLE` is a property of *stock*, not of an order, so it lives
in the `inventory.available` bucket. Each transition declares the stock movement it
requires ([`src/domain/stateMachine.ts`](src/domain/stateMachine.ts)), and a single
function (`transition()` in `orderService.ts`) applies the movement, updates the order and
writes the audit event in one transaction. No code path can change state without moving
stock consistently.

Deliberate rules:
- **No cancel once payment started.** Money may be in flight. Only the payment outcome or
  the payment deadline can end a `PAYMENT_PENDING` order.
- **`CONFIRMED` is final.** A stray `FAILED` webhook after a success is ignored.
- **Late payments are never served from someone else's reservation.** An expired order
  can only take a unit that is genuinely `available`, otherwise it is refunded.

---

## 5. How "never oversell" is guaranteed

Three layers. Any one of them alone would prevent overselling.

**1. Atomic conditional update (the mechanism).**
```sql
UPDATE inventory SET available = available - 1, reserved = reserved + 1
WHERE product_id = $1 AND warehouse_id = $2 AND available >= 1
```
Postgres takes a row lock and, under READ COMMITTED, re-evaluates `available >= 1` against
the latest committed row before updating. If two buyers race for the last unit, the
second one's condition is false and it updates zero rows: "sold out". No
read-then-write gap exists for a race to slip into.

**2. Database constraints (the safety net).**
```sql
CHECK (available >= 0) ... CHECK (available + reserved + sold = total)
```
Even a bug in application code cannot make Postgres store a negative count or create a
unit out of nothing. A test proves the database rejects such writes.

**3. Continuous verification (the proof).** `/admin/invariants` cross-checks, in one
consistent snapshot, that every unit in `reserved` belongs to a `RESERVED` or
`PAYMENT_PENDING` order and every unit in `sold` belongs to a `CONFIRMED` order. The
dashboard runs it every 500 ms, and the load test ends by checking it again, along with
the provider's books (every kept payment = one confirmed order).

**Multiple warehouses.** Stock is split across Bengaluru (50), Delhi (30) and Mumbai (20).
A reservation tries the warehouse with the most stock first, then falls back to the others.
This spreads concurrent buyers across three rows instead of queueing them all on one hot
row. The warehouse list is read without locks and may be stale, but it only decides the
*order* of attempts; the conditional update decides who wins.

---

## 6. Failures and edge cases

Almost every row below is exercised by an integration test
(`test/orders.integration.test.ts`), the chaos load test, or both. Forged webhooks were
checked by hand. Overload shedding (`503`) is implemented but was never triggered in my
load tests on this machine.

| Situation | What happens | Why it's safe |
|---|---|---|
| **10,000 concurrent requests for 100 units** | Exactly 100 reservations; the rest get `409 SOLD_OUT` | Conditional update + row lock. After a process sees "sold out" it answers from memory for 250 ms instead of taking more locks. |
| **Duplicate request / client retry** (same Idempotency-Key) | Same order returned (`200 REPLAYED`), no second unit taken | The key is claimed by a unique index *before* stock is touched. A concurrent duplicate waits on that index and then sees the first order. |
| **Same key, different body** | `422 IDEMPOTENCY_KEY_REUSED` | Refuse rather than guess what the client meant. |
| **Same user, several tabs/keys** | One order; others get `409 LIMIT_ONE_PER_CUSTOMER` | Partial unique index on `(user_id, product_id)` over holding/confirmed states. |
| **Reservation never paid** | Expires after 15s; unit returns to `available` and is resold (wave 2 of the load test) | Sweeper with `FOR UPDATE SKIP LOCKED`, safe to run in every process. |
| **Pay after the reservation expired** | `409`, order `EXPIRED`, no payment created | Expiry is checked under the row lock before moving to `PAYMENT_PENDING`. |
| **Payment provider times out on create** | `202 PAYMENT_PENDING` with a note; reconciler resolves it | We commit `PAYMENT_PENDING` *before* calling the provider, so the provider never holds a payment for an order we might expire under it. |
| **Duplicate webhook** | Processed once | Event id stored in `payment_events` (primary key) in the same transaction as its effect. Even a duplicate with a new id is a no-op, because the transition only fires from `PAYMENT_PENDING`. |
| **Lost webhook** | Reconciler polls the provider after 3s and confirms or fails the order | The provider is the source of truth for money; we ask it. |
| **Crash after reservation, before response** | Client retries with the same key and gets its order | Idempotency. |
| **Crash after `PAYMENT_PENDING`, before calling provider** | Reconciler finds no payment at the deadline: `EXPIRED`, unit released | `payment_never_started` |
| **Crash after provider created the payment** | Webhook still arrives (or the reconciler finds it) and confirms | Creation is idempotent on orderId; the outcome doesn't depend on our response. |
| **Crash mid-webhook transaction** | Transaction rolls back; webhook got no 2xx; provider redelivers; another worker processes it | Effect and dedupe record commit together or not at all. |
| **Payment still pending at the deadline** | Ask provider to cancel. Cancelled: release the unit. Provider refuses: release anyway and keep watching. | The unit must not be held forever by an undecided payment. |
| **Payment succeeds after the order expired** | Unit still available: `CONFIRMED`. None left: `REFUND_PENDING` → `REFUNDED`. | Never takes a unit held by someone else. Never keeps money without a sale. |
| **...and that late webhook is lost too** | Expired-payment watcher finds the charge at the provider | `payment_resolved` flag: we keep asking until the provider's outcome is final. |
| **Payment provider down** | Orders stay `PAYMENT_PENDING`, units stay held, retried every interval | We can't know if the customer paid, so we keep the unit rather than risk selling it twice (see trade-offs). |
| **Overload** | `503 Retry-After: 1` when a process has >300 requests queued for a DB connection | Shed load quickly instead of timing out slowly. Clients retry with the same key. |
| **Forged webhook** | `401` | HMAC-SHA256 signature over the raw body, constant-time compare. |
| **A worker process dies** | The cluster primary starts a replacement; other workers keep serving | Workers are stateless. Background jobs have no leader, so nothing waits for the dead one. |

---

## 7. Technical decisions and why

**Postgres as the single source of truth, no Redis.**
The usual flash-sale design puts a Redis counter in front (`DECR` / Lua) for speed.
I chose not to. With a Redis counter, every purchase is a write to two systems that can
disagree after a crash: Redis says sold, Postgres has no order, or the reverse. Keeping
them in sync needs its own reconciliation. With 100 units the database sees at most ~100
successful reservation transactions; every other request is a cheap "sold out". A single
transactional store makes the correctness argument short: *one transaction, one row lock,
one CHECK constraint.* Redis is what I'd add for a much larger sale, as an admission gate
in front of Postgres, never as the source of truth (see §9).

**Pessimistic row locks via conditional UPDATE, not optimistic version checks.**
Under extreme contention, optimistic concurrency (read version, write if unchanged)
makes most writers fail and retry, so throughput collapses. A conditional UPDATE queues
writers on the row lock instead, and each holds it only until its short transaction
commits (around a millisecond), so nobody's work is thrown away. Order rows are
also locked with `SELECT ... FOR UPDATE` before any transition, so concurrent webhooks,
reconcilers and sweepers serialise on each order.

**READ COMMITTED, not SERIALIZABLE.**
Correctness comes from row locks and conditional writes, not from snapshot isolation.
SERIALIZABLE would add aborts under contention without adding safety here. Locks are
always taken in the order *orders → inventory*, and a batch job that touches several
inventory rows takes them in warehouse order, so deadlocks shouldn't happen. If Postgres
ever reports one anyway, the transaction is retried.

**Idempotency key claimed before stock is touched.**
Inserting the order row first (unique on `(user_id, idempotency_key)`) means a duplicate
request blocks on the index and then *finds* the first order. It never reaches the
inventory row. If the first attempt rolls back (sold out), the duplicate proceeds normally.

**Commit `PAYMENT_PENDING` before calling the payment provider.**
The opposite order ("call provider, then save") leaves a window where money exists for an
order we still consider `RESERVED`, which the sweeper could expire. This way, the worst
case after a crash is a `PAYMENT_PENDING` order with no payment, which the reconciler
handles.

**Webhook + reconciliation, not webhook alone.**
Webhooks are the fast path; polling the provider is the safety net. Both go through the same
`applyPaymentResult()`, which is idempotent, so it doesn't matter which arrives first or
whether both do.

**No leader election for background jobs.**
Every worker runs every job. Jobs claim rows with `FOR UPDATE SKIP LOCKED` (and stamp
`reconciled_at`), so they divide work instead of duplicating it, and every effect is
re-checked under a lock. A leader would be a single point of failure and need failover;
idempotent jobs don't.

**Database clock for all deadlines.**
`expires_at`, `payment_deadline` and the "is it overdue" checks all use Postgres `now()`,
so worker processes with skewed clocks can't disagree about whether a reservation expired.

**Node.js cluster with TypeScript and Fastify.**
The workload is I/O-bound (waiting on Postgres and the provider), which suits Node's event
loop. `cluster` gives real multi-process concurrency on one machine, and the same stateless
workers would run unchanged as containers.

---

## 8. Trade-offs and limitations

**What I optimised for:** correctness under concurrency and failure, then
recoverability without humans, then simplicity of the correctness argument.

**What I sacrificed:**

- **Peak throughput.** Every reservation attempt that isn't stopped by the sold-out hint
  goes to Postgres. On my laptop (load generator, 4 workers, Postgres and the payment mock
  sharing 8 CPU cores) the system handles about 1,000-1,500 purchase requests/s end to end.
  Postgres alone measured about 3,300 simple queries/s on the same machine. The load test's
  reported latency (p50 ≈ 3-4s) is mostly time spent queued in the client's
  256-connection pool, because 10,000 requests are fired at once. For 100 units that's
  fine: in a measured run, all 100 units were reserved within ~0.5 s of the first
  reservation. For 1M buyers I'd add an admission layer (§9).
- **Availability when the payment provider is down.** If we can't ask the provider, we
  keep holding units in `PAYMENT_PENDING` rather than release them. During a provider
  outage some units are stuck until it recovers. The alternative (release on timeout) risks
  charging a customer for a unit we resold. We do handle that case (refund), but refunds
  are bad UX and cost money, so I'd rather hold.
- **Fairness of late payments.** A late payment takes a unit back from the `available`
  pool if one exists, ahead of buyers who might be about to reserve it. I chose to honour
  money already taken over a hypothetical next buyer.
- **The sold-out hint can briefly say "sold out" when a unit was just released.** For up
  to 250 ms. A retry then gets the unit. This trades a tiny window of false negatives for
  not having thousands of losing requests lock the hot rows.
- **One unit per order.** Multi-unit orders would need all-or-nothing allocation across
  warehouses (split shipments), which flash sales usually forbid anyway.

**Limitations of this implementation:**

- Single Postgres primary. It is the scaling ceiling and a single point of failure (a
  managed Postgres with synchronous replication and failover would be the production answer).
- The payment provider is a mock with in-memory state. Restarting it forgets payments, so
  on startup the order service starts a fresh sale if the provider has no record of payments
  our orders reference, and the dashboard flags the mismatch if it happens mid-session.
- No authentication on the buyer API; `userId` is trusted from the request body.
  `/admin/*` endpoints are open (disable with `ALLOW_ADMIN=false`).
- Everything runs on one machine. "Distributed" here means multiple independent processes
  coordinating only through the database, which is the same model as multiple hosts, but
  not tested across real network partitions.
- No queueing or waiting room: a buyer who gets "sold out" must retry by hand to catch
  released units.

---

## 9. What I would do with more time

1. **Admission control in front of the database.** A Redis counter (atomic `DECR`)
   initialised to the stock count, used only as a gate: once it hits zero, requests are
   rejected without touching Postgres. Postgres stays authoritative; Redis can only make
   us say "sold out" early, never oversell. Periodically re-sync it from Postgres as units
   are released.
2. **A virtual waiting room / queue.** Let buyers queue in order of arrival and admit them
   at the rate Postgres can serve. Fairer than "whoever's retry lands first" and avoids the
   thundering herd.
3. **Stock sharding.** Split each warehouse's stock into several rows (e.g. 10 rows of 10
   units) to multiply lock parallelism on the hot path.
4. **Outbox pattern for events.** Publish `order_confirmed` etc. to Kafka from an outbox
   table in the same transaction, for downstream systems (fulfilment, notifications).
5. **Real observability.** Metrics (reservation latency, lock waits, reconciler lag),
   tracing across the provider call, and alerts on any invariant failure.
6. **Load test at scale on separate machines** to find the true limit, and a k6 script
   for reproducibility.
7. **Auth and bot protection**: signed user sessions, per-IP rate limits, CAPTCHA before
   the sale opens.

---

## 10. Project layout and API

```
src/
  main.ts                    cluster primary (migrations, restarts workers) and workers
  config.ts                  every tunable, from env vars
  api/server.ts              HTTP API, webhook endpoint, admin endpoints
  domain/stateMachine.ts     states, allowed transitions, stock movement per transition
  services/orderService.ts   reserve, pay, webhook handling, cancel, background job logic
  services/inventory.ts      the atomic stock moves
  services/paymentClient.ts  payment provider client and webhook signatures
  services/admin.ts          invariant checker, stats
  jobs/index.ts              background job runner
  db/schema.sql              schema, constraints, indexes
  faults.ts                  crash injection for chaos testing
payment-provider/server.ts   mock payment provider (separate process)
scripts/up.ts                runs everything; CHAOS=1 for fault injection
scripts/loadtest.ts          10k-buyer load test with verdicts
scripts/db.ts                embedded Postgres
public/dashboard.html        live dashboard
test/                        state machine unit tests, integration tests against real Postgres

| Method & path | Purpose | Responses |
|---|---|---|
| `POST /api/orders` (`Idempotency-Key` header, `{userId, productId?}`) | Reserve one unit | `201` reserved · `200` replayed · `409 SOLD_OUT` · `409 LIMIT_ONE_PER_CUSTOMER` · `422` key reused · `503` overloaded |
| `POST /api/orders/:id/pay` | Start payment (idempotent) | `202 PAYMENT_PENDING` · `200` already confirmed · `409` not payable |
| `POST /api/orders/:id/cancel` | Cancel a reservation | `200` · `409` if payment started |
| `GET /api/orders/:id` | Order status | |
| `GET /api/products/:id/availability` | Units left | |
| `POST /webhooks/payment` | Payment provider callback (HMAC-signed) | `200` · `401` bad signature |
| `GET /admin/stats`, `GET /admin/invariants` | Dashboard data, invariant report | |
| `POST /admin/reset`, `POST /admin/crash` | Restock and clear orders and provider payments, kill a worker (demo) | |
