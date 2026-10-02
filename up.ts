// One command to run everything: Postgres (unless DATABASE_URL is set), the mock payment
// provider and the order service. `CHAOS=1 npm run up` also turns on crash injection and a
// misbehaving payment provider.
import { spawn, type ChildProcess } from 'node:child_process';

const chaos = process.env.CHAOS === '1';
const children: ChildProcess[] = [];

const chaosEnv: Record<string, string> = chaos
  ? {
      FAULTS:
        'reserve_after_commit=0.002,pay_before_provider_call=0.01,pay_after_provider_call=0.01,webhook_before_commit=0.03',
      PSP_LOST_WEBHOOK_RATE: '0.15',
      PSP_DUPLICATE_RATE: '0.5',
      PSP_SLOW_RESPONSE_RATE: '0.1',
      PSP_LATE_SETTLE_RATE: '0.05',
      PSP_CANCEL_REFUSE_RATE: '0.5',
    }
  : {};

function run(name: string, color: number, args: string[], readyText?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', ...args], {
      env: { ...process.env, ...chaosEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const tag = `\x1b[${color}m[${name}]\x1b[0m`;
    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        console.log(`${tag} ${line}`);
        if (readyText && line.includes(readyText)) resolve();
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('exit', (code) => {
      console.log(`${tag} exited (${code})`);
      reject(new Error(`${name} exited`));
    });
    if (!readyText) resolve();
  });
}

process.on('SIGINT', () => {
  for (const c of children) c.kill('SIGINT');
  setTimeout(() => process.exit(0), 2000);
});

if (chaos) console.log('CHAOS mode:', chaosEnv);
if (!process.env.DATABASE_URL) await run('db', 34, ['scripts/db.ts'], 'DB_READY');
await run('psp', 35, ['payment-provider/server.ts'], 'listening');
await run('api', 32, ['src/main.ts'], 'ready');
console.log('\nOrder service: http://localhost:3000   Dashboard: http://localhost:3000/dashboard\n');
