import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { BeastDatabase } from './client.js';

export const jobTypes = [
  'ANALYZE_CONVERSATION',
  'SEND_CUSTOMER_MESSAGE',
  'HANDOFF_CONVERSATION',
  'APPLY_CONVERSATION_LABEL',
  'SEND_SELLER_SUMMARY',
] as const;

export type JobType = typeof jobTypes[number];

export interface ClaimedJob {
  id: string;
  jobType: JobType;
  deduplicationKey: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueJobInput {
  jobType: JobType;
  deduplicationKey: string;
  payload: unknown;
  availableAt?: Date;
  maxAttempts?: number;
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function jobErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error'
      ? `${error.name}: ${error.message}`
      : error.message;
  }
  return String(error);
}

export async function enqueueJob(db: BeastDatabase, input: EnqueueJobInput): Promise<void> {
  await db.insertInto('jobs').values({
    id: randomUUID(),
    job_type: input.jobType,
    deduplication_key: input.deduplicationKey,
    payload: JSON.stringify(input.payload),
    status: 'PENDING',
    attempts: 0,
    max_attempts: input.maxAttempts ?? 5,
    available_at: input.availableAt ?? new Date(),
    locked_at: null,
    locked_by: null,
    last_error: null,
  }).onDuplicateKeyUpdate({
    deduplication_key: sql<string>`deduplication_key`,
  }).execute();
}

export async function recoverStaleJobs(
  db: BeastDatabase,
  staleBefore: Date,
): Promise<void> {
  await db.updateTable('jobs').set({
    status: 'PENDING',
    locked_at: null,
    locked_by: null,
    last_error: 'El worker recuperó el trabajo después de un bloqueo o reinicio',
  }).where('status', '=', 'PROCESSING')
    .where('locked_at', '<', staleBefore)
    .whereRef('attempts', '<', 'max_attempts')
    .execute();

  await db.updateTable('jobs').set({
    status: 'FAILED',
    locked_at: null,
    locked_by: null,
    last_error: 'Se agotaron los intentos después de recuperar un trabajo bloqueado',
  }).where('status', '=', 'PROCESSING')
    .where('locked_at', '<', staleBefore)
    .whereRef('attempts', '>=', 'max_attempts')
    .execute();
}

export async function claimNextJob(
  db: BeastDatabase,
  workerId: string,
  acceptedTypes: readonly JobType[] = jobTypes,
): Promise<ClaimedJob | null> {
  return db.transaction().execute(async (transaction) => {
    const row = await transaction.selectFrom('jobs').selectAll()
      .where('status', '=', 'PENDING')
      .where('available_at', '<=', new Date())
      .where('job_type', 'in', [...acceptedTypes])
      .orderBy('available_at', 'asc')
      .orderBy('created_at', 'asc')
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!row) return null;

    await transaction.updateTable('jobs').set({
      status: 'PROCESSING',
      attempts: sql<number>`attempts + 1`,
      locked_at: new Date(),
      locked_by: workerId,
      last_error: null,
    }).where('id', '=', row.id).where('status', '=', 'PENDING').execute();

    return {
      id: row.id,
      jobType: row.job_type as JobType,
      deduplicationKey: row.deduplication_key,
      payload: parsePayload(row.payload),
      attempts: row.attempts + 1,
      maxAttempts: row.max_attempts,
    };
  });
}

export async function completeJob(
  db: BeastDatabase,
  jobId: string,
  workerId: string,
): Promise<void> {
  await db.updateTable('jobs').set({
    status: 'COMPLETED',
    locked_at: null,
    locked_by: null,
    last_error: null,
  }).where('id', '=', jobId).where('locked_by', '=', workerId).execute();
}

export async function deferJob(
  db: BeastDatabase,
  jobId: string,
  workerId: string,
  availableAt: Date,
  detail: string,
): Promise<void> {
  await db.updateTable('jobs').set({
    status: 'PENDING',
    attempts: sql<number>`greatest(attempts - 1, 0)`,
    available_at: availableAt,
    locked_at: null,
    locked_by: null,
    last_error: detail.slice(0, 4000),
  }).where('id', '=', jobId).where('locked_by', '=', workerId).execute();
}

export async function failJob(
  db: BeastDatabase,
  job: ClaimedJob,
  workerId: string,
  error: unknown,
): Promise<void> {
  const detail = jobErrorDetail(error);
  const exhausted = job.attempts >= job.maxAttempts;
  const delaySeconds = Math.min(300, 5 * (3 ** Math.max(0, job.attempts - 1)));
  await db.updateTable('jobs').set({
    status: exhausted ? 'FAILED' : 'PENDING',
    available_at: new Date(Date.now() + delaySeconds * 1000),
    locked_at: null,
    locked_by: null,
    last_error: detail.slice(0, 4000),
  }).where('id', '=', job.id).where('locked_by', '=', workerId).execute();
}

export async function failJobPermanently(
  db: BeastDatabase,
  jobId: string,
  workerId: string,
  error: unknown,
): Promise<void> {
  const detail = jobErrorDetail(error);
  await db.updateTable('jobs').set({
    status: 'FAILED',
    locked_at: null,
    locked_by: null,
    last_error: detail.slice(0, 4000),
  }).where('id', '=', jobId).where('locked_by', '=', workerId).execute();
}
