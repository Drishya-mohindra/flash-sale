import { config } from '../config';
import {
  expireReservations,
  processRefunds,
  reconcileExpiredPayments,
  reconcilePendingPayments,
} from '../services/orderService';

// Every worker process runs every job. There is no leader election: each job claims its
// rows with FOR UPDATE SKIP LOCKED and every transition re-checks state under a lock, so
// running a job twice is harmless. If a process dies, the others carry on.
const JOBS: Record<string, () => Promise<number>> = {
  'expire-reservations': () => expireReservations(),
  'reconcile-payments': () => reconcilePendingPayments(),
  'watch-expired-payments': () => reconcileExpiredPayments(),
  'process-refunds': () => processRefunds(),
};

export function startBackgroundJobs(): () => void {
  const timers = Object.entries(JOBS).map(([name, run]) => {
    let running = false;
    return setInterval(async () => {
      if (running) return; // never overlap runs of the same job in one process
      running = true;
      try {
        await run();
      } catch (err) {
        console.error(`[job ${name}] ${(err as Error).message}`);
      } finally {
        running = false;
      }
    }, config.jobIntervalMs);
  });
  return () => timers.forEach(clearInterval);
}
