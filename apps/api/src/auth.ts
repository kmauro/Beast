import { createHash, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiConfig } from './config.js';

const COOKIE_NAME = 'beast_panel_session';
const SESSION_SECONDS = 8 * 60 * 60;

const LoginSchema = z.object({
  username: z.string().min(1).max(80),
  password: z.string().min(1).max(512),
});

interface SessionPayload {
  username: string;
  expiresAt: number;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function encodeSession(payload: SessionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function readSession(request: FastifyRequest): SessionPayload | null {
  const cookie = request.cookies[COOKIE_NAME];
  if (!cookie) return null;

  const unsigned = request.unsignCookie(cookie);
  if (!unsigned.valid || !unsigned.value) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(unsigned.value, 'base64url').toString('utf8'),
    ) as Partial<SessionPayload>;

    if (
      typeof payload.username !== 'string' ||
      typeof payload.expiresAt !== 'number' ||
      payload.expiresAt <= Date.now()
    ) {
      return null;
    }

    return { username: payload.username, expiresAt: payload.expiresAt };
  } catch {
    return null;
  }
}

export function createAuthGuard() {
  return async function requireAuthentication(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!readSession(request)) {
      await reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    }
  };
}

export function createSameOriginGuard() {
  return async function requireSameOrigin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;

    const origin = request.headers.origin;
    const host = request.headers.host;
    if (!origin || !host) return;

    try {
      if (new URL(origin).host !== host) {
        await reply.code(403).send({ error: 'INVALID_ORIGIN' });
      }
    } catch {
      await reply.code(403).send({ error: 'INVALID_ORIGIN' });
    }
  };
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: ApiConfig,
): Promise<void> {
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_CREDENTIALS' });
    }

    const valid =
      safeEqual(parsed.data.username, config.PANEL_ADMIN_USERNAME) &&
      safeEqual(parsed.data.password, config.PANEL_ADMIN_PASSWORD);

    if (!valid) {
      await delay(500);
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    const session = encodeSession({
      username: config.PANEL_ADMIN_USERNAME,
      expiresAt: Date.now() + SESSION_SECONDS * 1000,
    });

    reply.setCookie(COOKIE_NAME, session, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.PANEL_COOKIE_SECURE,
      signed: true,
      maxAge: SESSION_SECONDS,
    });

    return { username: config.PANEL_ADMIN_USERNAME };
  });

  app.get('/api/auth/session', async (request, reply) => {
    const session = readSession(request);
    if (!session) {
      return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    }

    return { username: session.username };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.code(204).send();
  });
}
