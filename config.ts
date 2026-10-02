// All tunables live here so the demo can be reshaped with environment variables.
const num = (key: string, fallback: number) =>
  process.env[key] !== undefined ? Number(process.env[key]) : fallback;

export const config = {
  port: num('PORT', 3000),
  workers: num('WORKERS', 4),
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/flashsale',
  // Per-process connection pool. Total DB connections = workers * poolSize.
  poolSize: num('DB_POOL_SIZE', 10),
  // Admission control: when more than this many requests are queued waiting for a DB
  // connection in one process, new purchase attempts get 503 + Retry-After instead of
  // piling up and timing out.
  maxQueuedDbRequests: num('MAX_QUEUED_DB_REQUESTS', 300),

  // How long a RESERVED order holds stock before the sweeper releases it.
  reservationTtlMs: num('RESERVATION_TTL_MS', 15_000),
  // How long a PAYMENT_PENDING order may wait for the payment provider before we try to
  // cancel the payment and release the stock.
  paymentTimeoutMs: num('PAYMENT_TIMEOUT_MS', 20_000),
  // A PAYMENT_PENDING order with no webhook for this long gets polled at the provider.
  reconcileAfterMs: num('RECONCILE_AFTER_MS', 3_000),
  jobIntervalMs: num('JOB_INTERVAL_MS', 500),
  jobBatchSize: num('JOB_BATCH_SIZE', 100),

  paymentProviderUrl: process.env.PAYMENT_PROVIDER_URL ?? 'http://localhost:4000',
  paymentProviderTimeoutMs: num('PAYMENT_PROVIDER_TIMEOUT_MS', 2_000),
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${num('PORT', 3000)}`,
  webhookSecret: process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret',

  // After a product is seen sold out, short-circuit further attempts in this process for
  // this long. Stock can come back (expiry), so this must stay short.
  soldOutCacheMs: num('SOLD_OUT_CACHE_MS', 250),

  // "blr:50,del:30,mum:20" -> 100 units across three warehouses.
  seedStock: process.env.SEED_STOCK ?? 'blr:50,del:30,mum:20',
  allowAdmin: process.env.ALLOW_ADMIN !== 'false',
};

export const PRODUCT_ID = 'phone-x';
