import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { createDatabase, SensitiveDataCipher } from '@beast/database';
import 'dotenv/config';
import Fastify from 'fastify';
import { createAuthGuard, createSameOriginGuard, registerAuthRoutes } from './auth.js';
import { loadConfig } from './config.js';
import { registerConversationRoutes } from './conversations.js';
import { registerFormRoutes } from './forms.js';
import { getSystemHealth } from './health.js';

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const cipher = new SensitiveDataCipher(config.DATA_ENCRYPTION_KEY);
const app = Fastify({ logger: true });
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(currentDirectory, '../../web');

await app.register(cookie, { secret: config.SESSION_SECRET });
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

app.addHook('preHandler', createSameOriginGuard());
await registerAuthRoutes(app, config);

await app.register(
  async (protectedApi) => {
    protectedApi.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
    });
    protectedApi.addHook('preHandler', createAuthGuard());
    await registerConversationRoutes(protectedApi, db, cipher);
    await registerFormRoutes(protectedApi, db);
  },
  { prefix: '/api' },
);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Deteniendo API');
  await app.close();
  await db.destroy();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
