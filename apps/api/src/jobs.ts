import type { BeastDatabase } from '@beast/database';
import type { FailedJobItem } from '@beast/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function registerJobRoutes(app: FastifyInstance, db: BeastDatabase): Promise<void> {
  app.get('/jobs/failed', async (): Promise<FailedJobItem[]> => {
    const rows = await db.selectFrom('jobs')
      .select(['id', 'job_type', 'attempts', 'max_attempts', 'last_error', 'created_at'])
      .where('status', '=', 'FAILED')
      .orderBy('created_at', 'desc').limit(50).execute();
    return rows.map((row) => ({
      id: row.id,
      jobType: row.job_type,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      createdAt: new Date(row.created_at as unknown as Date | string).toISOString(),
    }));
  });

  app.post('/jobs/:id/retry', async (request, reply) => {
    const parsed = ParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_JOB_ID' });
    const retried = await db.transaction().execute(async (transaction) => {
      const job = await transaction.selectFrom('jobs').select(['id', 'job_type'])
        .where('id', '=', parsed.data.id).where('status', '=', 'FAILED')
        .forUpdate().executeTakeFirst();
      if (!job) return false;
      await transaction.updateTable('jobs').set({
        status: 'PENDING',
        attempts: 0,
        available_at: new Date(),
        locked_at: null,
        locked_by: null,
        last_error: null,
      }).where('id', '=', job.id).execute();
      await transaction.insertInto('audit_log').values({
        actor_user_id: null,
        action: 'FAILED_JOB_RETRIED',
        entity_type: 'job',
        entity_id: job.id,
        before_json: JSON.stringify({ status: 'FAILED' }),
        after_json: JSON.stringify({ status: 'PENDING', jobType: job.job_type }),
      }).execute();
      return true;
    });
    if (!retried) return reply.code(404).send({ error: 'FAILED_JOB_NOT_FOUND' });
    return reply.code(204).send();
  });
}
