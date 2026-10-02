// Runs a real Postgres server from npm-installed binaries, so the project needs no Docker
// or system install. Data lives outside the repo (and outside any synced folder).
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const port = Number(process.env.PG_PORT ?? 54329);
const dataDir =
  process.env.PG_DATA_DIR ?? path.join(os.homedir(), '.flash-sale-inventory', `pgdata-${port}`);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  postgresFlags: ['-c', 'max_connections=200'],
  onLog: () => {},
  onError: (e) => console.error('[postgres]', e),
});

if (!existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
await pg.createDatabase('flashsale').catch(() => {}); // already exists
console.log(`DB_READY postgres://postgres:postgres@localhost:${port}/flashsale`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
