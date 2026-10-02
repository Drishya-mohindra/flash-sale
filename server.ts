// A mock payment service provider (PSP), run as its own process. It behaves like a real
// one in the ways that matter for correctness, and can misbehave on demand:
//
//   - create-payment is idempotent on orderId
//   - the outcome arrives later through a signed webhook, delivered at least once
//     (retried with backoff until the merchant answers 2xx)
//   - failureRate          payments that are declined
//   - duplicateRate        webhooks delivered twice
//   - lostWebhookRate      payments that settle but whose webhook is never sent
//   - slowResponseRate     create-payment calls that answer after 5s (the client times out,
//                          but the payment does exist)
//   - lateSettleRate       payments that only settle after lateSettleMs (past our deadline)
//   - cancelRefuseRate     cancel requests refused ("already processing")
//
// State is in memory: restarting the provider forgets every payment. That is a property of
// the mock, not of the design.

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { signWebhook } from '../src/services/paymentClient';

type Status = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
interface Payment {
  id: string;
  orderId: string;
  amountCents: number;
  status: Status;
  callbackUrl: string;
  createdAt: number;
}

const env = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const cfg = {
  minSettleMs: env('PSP_MIN_SETTLE_MS', 200),
  maxSettleMs: env('PSP_MAX_SETTLE_MS', 1500),
  failureRate: env('PSP_FAILURE_RATE', 0.1),
  duplicateRate: env('PSP_DUPLICATE_RATE', 0.2),
  lostWebhookRate: env('PSP_LOST_WEBHOOK_RATE', 0.05),
  slowResponseRate: env('PSP_SLOW_RESPONSE_RATE', 0.03),
  lateSettleRate: env('PSP_LATE_SETTLE_RATE', 0.0),
  lateSettleMs: env('PSP_LATE_SETTLE_MS', 30_000),
  cancelRefuseRate: env('PSP_CANCEL_REFUSE_RATE', 0.0),
};

const byOrder = new Map<string, Payment>();
const byId = new Map<string, Payment>();
const stats = {
  webhooksSent: 0,
  webhookDeliveryFailures: 0,
  duplicateWebhooks: 0,
  lostWebhooks: 0,
  slowResponses: 0,
  cancelsRefused: 0,
};
let generation = 0; // bumped on reset so stale timers from a previous run do nothing

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chance = (p: number) => Math.random() < p;

async function deliver(p: Payment, gen: number): Promise<void> {
  const body = JSON.stringify({
    eventId: `evt_${p.id}_${p.status}`,
    orderId: p.orderId,
    paymentId: p.id,
    status: p.status,
  });
  for (let attempt = 0; attempt < 12 && gen === generation; attempt++) {
    try {
      const res = await fetch(p.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': signWebhook(body) },
        body,
        signal: AbortSignal.timeout(3000),
      });
      stats.webhooksSent++;
      if (res.ok) return;
    } catch {
      // merchant down or crashed mid-request
    }
    stats.webhookDeliveryFailures++;
    await sleep(Math.min(200 * 2 ** attempt, 5000)); // exponential backoff
  }
}

function scheduleSettlement(p: Payment): void {
  const gen = generation;
  const delay = chance(cfg.lateSettleRate)
    ? cfg.lateSettleMs
    : cfg.minSettleMs + Math.random() * (cfg.maxSettleMs - cfg.minSettleMs);
  setTimeout(async () => {
    if (gen !== generation || p.status !== 'PENDING') return; // cancelled meanwhile
    p.status = chance(cfg.failureRate) ? 'FAILED' : 'SUCCEEDED';
    if (chance(cfg.lostWebhookRate)) {
      stats.lostWebhooks++;
      return; // money moved, merchant never told: only reconciliation can find this
    }
    if (chance(cfg.duplicateRate)) {
      stats.duplicateWebhooks++;
      void deliver(p, gen);
    }
    await deliver(p, gen);
  }, delay);
}

const app = Fastify({ logger: false });

app.post<{ Body: { orderId: string; amountCents: number; callbackUrl: string } }>(
  '/payments',
  async (req) => {
    const { orderId, amountCents, callbackUrl } = req.body;
    let p = byOrder.get(orderId);
    if (!p) {
      p = { id: `pay_${randomUUID()}`, orderId, amountCents, status: 'PENDING', callbackUrl, createdAt: Date.now() };
      byOrder.set(orderId, p);
      byId.set(p.id, p);
      scheduleSettlement(p);
    }
    if (chance(cfg.slowResponseRate)) {
      stats.slowResponses++;
      await sleep(5000);
    }
    return p;
  },
);

app.get<{ Params: { orderId: string } }>('/payments/by-order/:orderId', async (req, reply) => {
  const p = byOrder.get(req.params.orderId);
  return p ?? reply.code(404).send({ error: 'NOT_FOUND' });
});

app.post<{ Params: { id: string } }>('/payments/:id/cancel', async (req, reply) => {
  const p = byId.get(req.params.id);
  if (!p) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (p.status === 'PENDING') {
    if (chance(cfg.cancelRefuseRate)) stats.cancelsRefused++;
    else p.status = 'CANCELLED';
  }
  return p;
});

app.post<{ Params: { id: string } }>('/payments/:id/refund', async (req, reply) => {
  const p = byId.get(req.params.id);
  if (!p) return reply.code(404).send({ error: 'NOT_FOUND' });
  if (p.status === 'SUCCEEDED') p.status = 'REFUNDED';
  return p;
});

app.get('/admin/stats', async () => {
  const byStatus: Record<string, number> = {};
  for (const p of byId.values()) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  return { payments: byId.size, byStatus, ...stats, config: cfg };
});

app.post<{ Body: Partial<typeof cfg> }>('/admin/config', async (req) => {
  Object.assign(cfg, req.body);
  return cfg;
});

app.post('/admin/reset', async () => {
  generation++;
  byOrder.clear();
  byId.clear();
  for (const k of Object.keys(stats) as Array<keyof typeof stats>) stats[k] = 0;
  return { ok: true };
});

const port = env('PSP_PORT', 4000);
await app.listen({ port, host: '0.0.0.0' });
console.log(`[payment-provider] listening on :${port}`, cfg);
