-- Flash-sale schema. Postgres is the single source of truth for stock and order state.
-- Several invariants are enforced by the database itself, so that even a bug in the
-- application code cannot oversell.

CREATE TABLE IF NOT EXISTS products (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents > 0)
);

CREATE TABLE IF NOT EXISTS warehouses (
  id   text PRIMARY KEY,
  name text NOT NULL
);

-- One row per (product, warehouse). Every unit is in exactly one bucket:
--   available -> can be reserved
--   reserved  -> held by a RESERVED / PAYMENT_PENDING order
--   sold      -> belongs to a CONFIRMED order
CREATE TABLE IF NOT EXISTS inventory (
  product_id   text    NOT NULL REFERENCES products(id),
  warehouse_id text    NOT NULL REFERENCES warehouses(id),
  total        integer NOT NULL CHECK (total >= 0),
  available    integer NOT NULL CHECK (available >= 0),
  reserved     integer NOT NULL CHECK (reserved >= 0),
  sold         integer NOT NULL CHECK (sold >= 0),
  PRIMARY KEY (product_id, warehouse_id),
  -- Units are never created or destroyed by a state change, only moved between buckets.
  CONSTRAINT inventory_conservation CHECK (available + reserved + sold = total)
);

CREATE TABLE IF NOT EXISTS orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          text NOT NULL,
  -- Client-generated key: retries of the same purchase attempt map to the same order.
  idempotency_key  text NOT NULL,
  product_id       text NOT NULL REFERENCES products(id),
  warehouse_id     text REFERENCES warehouses(id),
  quantity         integer NOT NULL DEFAULT 1 CHECK (quantity = 1),
  state            text NOT NULL CHECK (state IN (
                     'RESERVED', 'PAYMENT_PENDING', 'CONFIRMED', 'EXPIRED',
                     'CANCELLED', 'PAYMENT_FAILED', 'REFUND_PENDING', 'REFUNDED')),
  amount_cents     integer NOT NULL,
  payment_id       text,
  expires_at       timestamptz NOT NULL,
  payment_deadline timestamptz,
  -- True once we know the provider-side outcome of this order's payment for certain
  -- (succeeded, failed, cancelled, or never created). Until then the reconciler keeps
  -- checking, even after the order expired, so no charge can go unnoticed.
  payment_resolved boolean NOT NULL DEFAULT false,
  reconciled_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 0,
  CONSTRAINT orders_idempotency UNIQUE (user_id, idempotency_key)
);

-- Business rule: one unit per customer. A user may have at most one order that holds or
-- owns stock for a product.
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_active_per_user
  ON orders (user_id, product_id)
  WHERE state IN ('RESERVED', 'PAYMENT_PENDING', 'CONFIRMED');

-- Partial indexes keep the background jobs' scans small however many orders exist.
CREATE INDEX IF NOT EXISTS orders_reserved_by_expiry
  ON orders (expires_at) WHERE state = 'RESERVED';
CREATE INDEX IF NOT EXISTS orders_payment_pending
  ON orders (updated_at) WHERE state = 'PAYMENT_PENDING';
CREATE INDEX IF NOT EXISTS orders_refund_pending
  ON orders (updated_at) WHERE state = 'REFUND_PENDING';
CREATE INDEX IF NOT EXISTS orders_expired_payment_unresolved
  ON orders (updated_at)
  WHERE state = 'EXPIRED' AND payment_deadline IS NOT NULL AND NOT payment_resolved;

-- Append-only audit log of every state transition.
CREATE TABLE IF NOT EXISTS order_events (
  id         bigserial PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES orders(id),
  from_state text,
  to_state   text NOT NULL,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events (order_id);

-- Inbox for payment-provider webhooks. The primary key deduplicates redelivered events.
CREATE TABLE IF NOT EXISTS payment_events (
  event_id    text PRIMARY KEY,
  order_id    uuid NOT NULL,
  payment_id  text NOT NULL,
  status      text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Purchase-attempt counters for the dashboard's demand funnel, one row per second and
-- outcome. Workers count in memory and flush deltas here, so the hot path never waits on it.
CREATE TABLE IF NOT EXISTS purchase_attempts (
  second  timestamptz NOT NULL,
  outcome text        NOT NULL,
  n       integer     NOT NULL,
  PRIMARY KEY (second, outcome)
);
