import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { createDatabase } from '@beast/database';
import 'dotenv/config';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { getSystemHealth } from './health.js';

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const app = Fastify({ logger: true });
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(currentDirectory, '../../web');

await app.register(cookie);
await app.register(fastifyStatic, {
  root: webRoot,
  wildcard: false,
});

app.get('/api/health', async (_request, reply) => {
  const health = await getSystemHealth(db, config);
  return reply.code(health.status === 'DOWN' ? 503 : 200).send(health);
});

app.get('/api/config/public', async () => ({
  timezone: process.env.BUSINESS_TIMEZONE ?? 'America/Argentina/Buenos_Aires',
  openTime: process.env.BUSINESS_OPEN_TIME ?? '09:00',
  closeTime: process.env.BUSINESS_CLOSE_TIME ?? '18:00',
  sellerBatchSize: Number(process.env.SELLER_BATCH_SIZE ?? 5),
}));

app.get('/', async (_request, reply) => reply.sendFile('index.html'));

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Deteniendo API');
  await app.close();
  await db.destroy();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });

