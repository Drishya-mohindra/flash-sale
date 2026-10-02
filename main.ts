import cluster from 'node:cluster';
import { buildServer } from './api/server';
import { config } from './config';
import { migrate, resetSale } from './db/migrate';
import { pool } from './db/pool';
import { startBackgroundJobs } from './jobs';
import { flush as flushAttempts } from './services/demand';

// The order service runs as N stateless worker processes sharing one port (Node cluster).
// They coordinate only through Postgres, which is what makes this "distributed": the same
// code would run unchanged as N containers behind a load balancer.

if (cluster.isPrimary) {
  await migrate();
  await resetIfProviderForgot();
  await pool.end();

  let shuttingDown = false;
  console.log(`[primary ${process.pid}] starting ${config.workers} workers on :${config.port}`);
  for (let i = 0; i < config.workers; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;
    console.warn(
      `[primary] worker ${worker.process.pid} died (${signal ?? code}); starting a replacement`,
    );
    cluster.fork();
  });

  const stop = () => {
    shuttingDown = true;
    for (const w of Object.values(cluster.workers ?? {})) w?.process.kill('SIGTERM');
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  const app = buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  const stopJobs = startBackgroundJobs();
  console.log(`[worker ${process.pid}] ready`);

  process.on('SIGTERM', async () => {
    stopJobs();
    await app.close();
    await flushAttempts();
    await pool.end();
    process.exit(0);
  });
}

/**
 * Postgres keeps the last sale across restarts, but the mock provider keeps payments in
 * memory. If the provider came back empty while our orders still reference payments, the
 * two sets of books can never agree again, so start a fresh sale instead.
 */
async function resetIfProviderForgot(): Promise<void> {
  const provider = await fetch(`${config.paymentProviderUrl}/admin/stats`, {
    signal: AbortSignal.timeout(1000),
  })
    .then((r) => r.json() as Promise<{ payments: number }>)
    .catch(() => null);
  if (!provider || provider.payments > 0) return;
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM orders WHERE payment_id IS NOT NULL',
  );
  if (rows[0].n === 0) return;
  console.warn(
    `[primary] payment provider has no record of ${rows[0].n} paid orders from a previous run; starting a fresh sale`,
  );
  await resetSale();
}
