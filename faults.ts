// Fault injection for the chaos demo. FAULTS="webhook_before_commit=0.05,pay_after_provider_call=0.02"
// makes a worker process die (like a kill -9) at that point with that probability.
//
// Crash points:
//   reserve_after_commit     reservation committed, response never sent
//   pay_before_provider_call order is PAYMENT_PENDING, provider never called
//   pay_after_provider_call  provider created the payment, we never recorded or answered
//   webhook_before_commit    webhook processed inside a transaction that never commits

export type CrashPoint =
  | 'reserve_after_commit'
  | 'pay_before_provider_call'
  | 'pay_after_provider_call'
  | 'webhook_before_commit';

const probabilities = new Map<string, number>(
  (process.env.FAULTS ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => {
      const [point, p] = pair.split('=');
      return [point.trim(), Number(p)] as [string, number];
    }),
);

export function maybeCrash(point: CrashPoint): void {
  const p = probabilities.get(point);
  if (p && Math.random() < p) {
    console.error(`[fault] worker ${process.pid} crashing at ${point}`);
    // Exit immediately: no cleanup, open transactions die with their connections.
    process.exit(137);
  }
}

export function activeFaults(): Record<string, number> {
  return Object.fromEntries(probabilities);
}
