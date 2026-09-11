import type { BeastDatabase } from '@beast/database';

export type WorkerStatus = 'UP' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';

export async function writeHeartbeat(
  db: BeastDatabase,
  status: WorkerStatus,
  detail: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date();
  const serializedMetadata = JSON.stringify(metadata);

  await db
    .insertInto('system_components')
    .values({
      component: 'whatsapp-worker',
      status,
      detail,
      metadata: serializedMetadata,
      checked_at: now,
    })
    .onDuplicateKeyUpdate({
      status,
      detail,
      metadata: serializedMetadata,
      checked_at: now,
    })
    .execute();
}

