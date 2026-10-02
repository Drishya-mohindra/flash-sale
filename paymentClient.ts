import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

export type ProviderPaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUNDED';

export interface ProviderPayment {
  id: string;
  orderId: string;
  amountCents: number;
  status: ProviderPaymentStatus;
}

/** The provider did not answer in time or was unreachable. The outcome is unknown. */
export class ProviderUnavailableError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${config.paymentProviderUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.paymentProviderTimeoutMs),
    });
  } catch (err) {
    throw new ProviderUnavailableError(`${method} ${path}: ${(err as Error).message}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ProviderUnavailableError(`${method} ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const paymentProvider = {
  /** Idempotent on orderId: calling twice returns the same payment. */
  async createPayment(orderId: string, amountCents: number): Promise<ProviderPayment> {
    const payment = await call<ProviderPayment>('POST', '/payments', {
      orderId,
      amountCents,
      callbackUrl: `${config.publicUrl}/webhooks/payment`,
    });
    if (!payment) throw new ProviderUnavailableError('createPayment returned 404');
    return payment;
  },
  getPaymentByOrder(orderId: string): Promise<ProviderPayment | null> {
    return call<ProviderPayment>('GET', `/payments/by-order/${orderId}`);
  },
  /** Cancels a PENDING payment. Returns the payment's status afterwards, which may not be CANCELLED. */
  cancelPayment(paymentId: string): Promise<ProviderPayment | null> {
    return call<ProviderPayment>('POST', `/payments/${paymentId}/cancel`);
  },
  refundPayment(paymentId: string): Promise<ProviderPayment | null> {
    return call<ProviderPayment>('POST', `/payments/${paymentId}/refund`);
  },
};

export type PaymentProvider = typeof paymentProvider;

export function signWebhook(rawBody: string, secret = config.webhookSecret): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signWebhook(rawBody));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
