import type { BeastDatabase } from '@beast/database';
import type { ComponentHealth, SystemHealth } from '@beast/shared';
import type { ApiConfig } from './config.js';

async function databaseHealth(db: BeastDatabase): Promise<ComponentHealth> {
  const checkedAt = new Date().toISOString();

  try {
    await db.selectFrom('system_components').select('component').limit(1).execute();
    return { component: 'mysql', status: 'UP', checkedAt, detail: null };
  } catch (error) {
    return {
      component: 'mysql',
      status: 'DOWN',
      checkedAt,
      detail: error instanceof Error ? error.message : 'Error desconocido',
    };
  }
}

async function ollamaHealth(config: ApiConfig): Promise<ComponentHealth> {
  const checkedAt = new Date().toISOString();

  try {
    const response = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      throw new Error(`Ollama respondió HTTP ${response.status}`);
    }

    const body = (await response.json()) as { models?: Array<{ name: string }> };
    const available = body.models?.some(
      (model) => model.name === config.OLLAMA_MODEL || model.name.startsWith(`${config.OLLAMA_MODEL}:`),
    );

    return {
      component: 'ollama',
      status: available ? 'UP' : 'DEGRADED',
      checkedAt,
      detail: available ? null : `El modelo ${config.OLLAMA_MODEL} no está descargado`,
    };
  } catch (error) {
    return {
      component: 'ollama',
      status: 'DOWN',
      checkedAt,
      detail: error instanceof Error ? error.message : 'Error desconocido',
    };
  }
}

async function workerHealth(db: BeastDatabase): Promise<ComponentHealth> {
  const checkedAt = new Date().toISOString();
  const row = await db
    .selectFrom('system_components')
    .select(['status', 'detail', 'checked_at'])
    .where('component', '=', 'whatsapp-worker')
    .executeTakeFirst();

  if (!row) {
    return { component: 'whatsapp', status: 'UNKNOWN', checkedAt, detail: 'Worker aún no registrado' };
  }

  const ageMs = Date.now() - new Date(row.checked_at).getTime();
  if (ageMs > 90_000) {
    return { component: 'whatsapp', status: 'DOWN', checkedAt, detail: 'Heartbeat vencido' };
  }

  return {
    component: 'whatsapp',
    status: row.status,
    checkedAt,
    detail: row.detail,
  };
}

export async function getSystemHealth(
  db: BeastDatabase,
  config: ApiConfig,
): Promise<SystemHealth> {
  const components = await Promise.all([
    databaseHealth(db),
    ollamaHealth(config),
    workerHealth(db).catch((error: unknown) => ({
      component: 'whatsapp',
      status: 'DOWN' as const,
      checkedAt: new Date().toISOString(),
      detail: error instanceof Error ? error.message : 'Error desconocido',
    })),
  ]);

  const status = components.some((component) => component.status === 'DOWN')
    ? 'DOWN'
    : components.some((component) => component.status !== 'UP')
      ? 'DEGRADED'
      : 'UP';

  return { status, checkedAt: new Date().toISOString(), components };
}

