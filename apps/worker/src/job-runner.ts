import { randomUUID } from 'node:crypto';
import {
  assignConversationToNextSeller,
  claimNextJob,
  completeJob,
  deferJob,
  failJob,
  failJobPermanently,
  recoverStaleJobs,
  type BeastDatabase,
  type ClaimedJob,
  type SensitiveDataCipher,
} from '@beast/database';
import { HandoffReasonSchema } from '@beast/shared';
import { z } from 'zod';
import type whatsapp from 'whatsapp-web.js';
import type { WorkerConfig } from './config.js';
import { ingestOutboundMessage, resolveWhatsAppMessageIdentity } from './message-ingestion.js';
import { OllamaClient } from './ollama.js';
import { QualificationProcessor } from './qualification.js';
import { WhatsAppLabelManager } from './whatsapp-labels.js';

type WhatsAppClient = whatsapp.Client;

const AnalysisPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  triggerMessageId: z.string().min(1),
});
const CustomerMessagePayloadSchema = AnalysisPayloadSchema.extend({
  bodyEncrypted: z.string().min(1),
});
const HandoffPayloadSchema = AnalysisPayloadSchema.extend({
  reason: HandoffReasonSchema,
  confidence: z.number().min(0).max(1),
  modelSummaryEncrypted: z.string().min(1),
});
const ConversationPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  force: z.boolean().default(false),
});
const SellerSummaryPayloadSchema = ConversationPayloadSchema.extend({ summaryId: z.string().uuid() });

class DeferredJobError extends Error {
  constructor(readonly until: Date, message: string) {
    super(message);
  }
}

class PermanentJobError extends Error {}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function decryptAnswer(cipher: SensitiveDataCipher, value: unknown): unknown {
  const parsed = parseJson<unknown>(value, null);
  if (typeof parsed === 'object' && parsed !== null && 'encrypted' in parsed) {
    const encrypted = (parsed as { encrypted?: unknown }).encrypted;
    if (typeof encrypted === 'string') {
      try {
        return JSON.parse(cipher.decrypt(encrypted)) as unknown;
      } catch {
        return null;
      }
    }
  }
  return parsed;
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (value === null || value === undefined) return 'Sin dato';
  return String(value);
}

function booleanValue(value: boolean | number): boolean {
  return value === true || value === 1;
}

function messageMarkerKey(chatId: string, body: string): string {
  return `${chatId}\u0000${body}`;
}

export class BotSendTracker {
  private readonly pending = new Map<string, number>();

  mark(chatId: string, body: string): void {
    const key = messageMarkerKey(chatId, body);
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
  }

  consume(chatId: string, body: string): boolean {
    const key = messageMarkerKey(chatId, body);
    const count = this.pending.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) this.pending.delete(key);
    else this.pending.set(key, count - 1);
    return true;
  }

  release(chatId: string, body: string): void {
    this.consume(chatId, body);
  }
}

export class PersistentJobRunner {
  private readonly workerId = `worker-${randomUUID()}`;
  private readonly qualification: QualificationProcessor;
  private running = false;
  private stopped = false;
  private nextOutboundAt = 0;
  private lastRecoveryAt = 0;

  constructor(
    private readonly db: BeastDatabase,
    private readonly cipher: SensitiveDataCipher,
    private readonly config: WorkerConfig,
    private readonly client: WhatsAppClient,
    private readonly labels: WhatsAppLabelManager,
    readonly sendTracker: BotSendTracker,
  ) {
    this.qualification = new QualificationProcessor(
      db,
      cipher,
      config,
      new OllamaClient(config),
    );
  }

  async initialize(): Promise<void> {
    await recoverStaleJobs(this.db, new Date());
    this.lastRecoveryAt = Date.now();
  }

  stop(): void {
    this.stopped = true;
  }

  async runOnce(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let job: ClaimedJob | null = null;
    try {
      const recoveryInterval = Math.min(60_000, Math.floor(this.config.JOB_STALE_AFTER_MS / 2));
      if (Date.now() - this.lastRecoveryAt >= recoveryInterval) {
        await recoverStaleJobs(this.db, new Date(Date.now() - this.config.JOB_STALE_AFTER_MS));
        this.lastRecoveryAt = Date.now();
      }
      job = await claimNextJob(this.db, this.workerId);
      if (!job) return;
      await this.handle(job);
      await completeJob(this.db, job.id, this.workerId);
    } catch (error) {
      if (!job) {
        console.error('No se pudo consultar la cola de trabajos:', error);
      } else if (error instanceof DeferredJobError) {
        await deferJob(this.db, job.id, this.workerId, error.until, error.message);
      } else if (error instanceof PermanentJobError || error instanceof z.ZodError) {
        await failJobPermanently(this.db, job.id, this.workerId, error);
        console.error('Trabajo descartado por un error permanente', { jobId: job.id, type: job.jobType, error });
      } else {
        await failJob(this.db, job, this.workerId, error);
        console.error('Trabajo reprogramado después de un fallo', {
          jobId: job.id,
          type: job.jobType,
          attempt: job.attempts,
          error,
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async handle(job: ClaimedJob): Promise<void> {
    if (job.jobType === 'ANALYZE_CONVERSATION') {
      if (!this.config.BOT_REPLY_ENABLED) return;
      const payload = AnalysisPayloadSchema.parse(job.payload);
      const outcome = await this.qualification.process(payload);
      console.log('Conversación analizada', { conversationId: payload.conversationId, ...outcome });
      return;
    }
    if (job.jobType === 'SEND_CUSTOMER_MESSAGE') {
      if (!this.config.BOT_REPLY_ENABLED) return;
      await this.sendCustomerMessage(CustomerMessagePayloadSchema.parse(job.payload));
      return;
    }
    if (job.jobType === 'HANDOFF_CONVERSATION') {
      if (!this.config.BOT_REPLY_ENABLED) return;
      await this.handoff(HandoffPayloadSchema.parse(job.payload));
      return;
    }
    if (job.jobType === 'APPLY_CONVERSATION_LABEL') {
      const payload = ConversationPayloadSchema.parse(job.payload);
      await this.labels.applyConversationLabel(payload.conversationId, payload.force);
      return;
    }
    if (job.jobType === 'SEND_SELLER_SUMMARY') {
      await this.sendSellerSummary(SellerSummaryPayloadSchema.parse(job.payload));
      return;
    }
    throw new PermanentJobError(`Tipo de trabajo no soportado: ${String(job.jobType)}`);
  }

  private enforceOutboundRate(): void {
    if (Date.now() < this.nextOutboundAt) {
      throw new DeferredJobError(new Date(this.nextOutboundAt), 'Límite global de mensajes salientes');
    }
  }

  private markOutboundSent(): void {
    this.nextOutboundAt = Date.now() + this.config.OUTBOUND_MIN_INTERVAL_MS;
  }

  private async sendCustomerMessage(payload: z.infer<typeof CustomerMessagePayloadSchema>): Promise<void> {
    const alreadySent = await this.db.selectFrom('audit_log').select('id')
      .where('action', '=', 'BOT_REPLY_SENT')
      .where('entity_type', '=', 'message_trigger')
      .where('entity_id', '=', payload.triggerMessageId)
      .executeTakeFirst();
    if (alreadySent) return;
    const conversation = await this.db.selectFrom('conversations')
      .select(['state', 'customer_number_encrypted'])
      .where('id', '=', payload.conversationId).executeTakeFirst();
    if (!conversation || ['CLOSED', 'SELLER_ASSIGNED', 'PENDING_FOLLOW_UP'].includes(conversation.state)) return;
    const latestInbound = await this.db.selectFrom('messages').select('whatsapp_message_id')
      .where('conversation_id', '=', payload.conversationId).where('direction', '=', 'INBOUND')
      .orderBy('occurred_at', 'desc').orderBy('created_at', 'desc').executeTakeFirst();
    if (!latestInbound || latestInbound.whatsapp_message_id !== payload.triggerMessageId) return;

    const latestBotMessage = await this.db.selectFrom('messages').select('occurred_at')
      .where('conversation_id', '=', payload.conversationId)
      .where('direction', '=', 'OUTBOUND').where('sender_type', '=', 'BOT')
      .orderBy('occurred_at', 'desc').executeTakeFirst();
    if (latestBotMessage) {
      const allowedAt = new Date(latestBotMessage.occurred_at).getTime() + this.config.BOT_REPLY_COOLDOWN_MS;
      if (Date.now() < allowedAt) {
        throw new DeferredJobError(new Date(allowedAt), 'Espera mínima entre respuestas del bot');
      }
    }
    this.enforceOutboundRate();
    const chatId = this.cipher.decrypt(conversation.customer_number_encrypted);
    const body = this.cipher.decrypt(payload.bodyEncrypted);
    this.sendTracker.mark(chatId, body);
    try {
      const message = await this.client.sendMessage(chatId, body);
      const ingestion = await ingestOutboundMessage(this.db, this.cipher, message, 'BOT', {
        action: 'BOT_REPLY_SENT',
        entityType: 'message_trigger',
        entityId: payload.triggerMessageId,
        after: { conversationId: payload.conversationId },
      });
      if (ingestion.outcome === 'ignored') throw new Error(ingestion.reason);
      this.markOutboundSent();
    } finally {
      this.sendTracker.release(chatId, body);
    }
  }

  private async handoff(payload: z.infer<typeof HandoffPayloadSchema>): Promise<void> {
    const conversation = await this.db.selectFrom('conversations as conversation')
      .leftJoin('conversation_services as selected', (join) => join
        .onRef('selected.conversation_id', '=', 'conversation.id')
        .on('selected.primary_service', '=', true))
      .leftJoin('service_catalog as service', 'service.id', 'selected.service_id')
      .select([
        'conversation.state',
        'conversation.customer_number_encrypted',
        'conversation.active_form_version_id',
        'service.code as service_code',
        'service.name as service_name',
      ])
      .where('conversation.id', '=', payload.conversationId).executeTakeFirst();
    if (!conversation || conversation.state === 'CLOSED' || conversation.state === 'SELLER_ASSIGNED') return;

    const answers = conversation.active_form_version_id
      ? await this.db.selectFrom('form_answers as answer')
        .innerJoin('form_fields as field', 'field.id', 'answer.form_field_id')
        .select(['field.field_key', 'field.label', 'field.include_in_summary', 'answer.value_json'])
        .where('answer.conversation_id', '=', payload.conversationId)
        .where('field.form_version_id', '=', conversation.active_form_version_id)
        .orderBy('field.display_order', 'asc').execute()
      : [];
    const summaryAnswers = answers.filter((answer) => booleanValue(answer.include_in_summary))
      .map((answer) => ({
        key: answer.field_key,
        label: answer.label,
        value: decryptAnswer(this.cipher, answer.value_json),
      }));
    let modelSummary = '';
    try {
      modelSummary = this.cipher.decrypt(payload.modelSummaryEncrypted).trim();
    } catch {
      modelSummary = '';
    }
    const customer = this.cipher.decrypt(conversation.customer_number_encrypted).replace(/@(c\.us|lid)$/, '');
    const lines = [
      'Nueva consulta derivada por Beast',
      `Cliente: ${customer}`,
      `Servicio: ${conversation.service_name ?? conversation.service_code ?? 'Sin confirmar'}`,
      `Motivo: ${payload.reason}`,
      `Confianza: ${Math.round(payload.confidence * 100)}%`,
      ...summaryAnswers.map((answer) => `${answer.label}: ${displayValue(answer.value)}`),
      ...(modelSummary ? [`Resumen: ${modelSummary}`] : []),
    ];
    await assignConversationToNextSeller(this.db, payload.conversationId, payload.reason, {
      textEncrypted: this.cipher.encrypt(lines.join('\n')),
      structuredDataEncrypted: this.cipher.encrypt(JSON.stringify({
        customer,
        serviceCode: conversation.service_code,
        reason: payload.reason,
        confidence: payload.confidence,
        answers: Object.fromEntries(summaryAnswers.map((answer) => [answer.key, answer.value])),
      })),
      modelName: this.config.OLLAMA_MODEL,
    });
  }

  private async sendSellerSummary(payload: z.infer<typeof SellerSummaryPayloadSchema>): Promise<void> {
    const alreadySent = await this.db.selectFrom('audit_log').select('id')
      .where('action', '=', 'SELLER_SUMMARY_SENT')
      .where('entity_type', '=', 'summary')
      .where('entity_id', '=', payload.summaryId)
      .executeTakeFirst();
    if (alreadySent) return;
    const record = await this.db.selectFrom('summaries as summary')
      .innerJoin('conversations as conversation', 'conversation.id', 'summary.conversation_id')
      .innerJoin('sellers as seller', 'seller.id', 'conversation.seller_id')
      .select([
        'summary.summary_text',
        'conversation.state',
        'seller.whatsapp_number_encrypted',
        'seller.id as seller_id',
      ])
      .where('summary.id', '=', payload.summaryId)
      .where('conversation.id', '=', payload.conversationId)
      .executeTakeFirst();
    if (!record) throw new PermanentJobError('No existe el resumen o el vendedor asignado');
    if (!['SELLER_ASSIGNED', 'PENDING_FOLLOW_UP'].includes(record.state)) return;
    const current = await this.db.selectFrom('conversations').select('state')
      .where('id', '=', payload.conversationId).executeTakeFirst();
    if (!current || !['SELLER_ASSIGNED', 'PENDING_FOLLOW_UP'].includes(current.state)) return;
    this.enforceOutboundRate();
    const digits = this.cipher.decrypt(record.whatsapp_number_encrypted).replace(/\D/g, '');
    if (digits.length < 8) throw new PermanentJobError('El número del vendedor no es válido');
    const chatId = `${digits}@c.us`;
    const body = this.cipher.decrypt(record.summary_text);
    this.sendTracker.mark(chatId, body);
    try {
      const message = await this.client.sendMessage(chatId, body);
      const identity = resolveWhatsAppMessageIdentity(message);
      await this.db.insertInto('audit_log').values({
        actor_user_id: null,
        action: 'SELLER_SUMMARY_SENT',
        entity_type: 'summary',
        entity_id: payload.summaryId,
        before_json: null,
        after_json: JSON.stringify({
          conversationId: payload.conversationId,
          sellerId: record.seller_id,
          whatsappMessageId: this.cipher.lookupHash(identity.value),
          identitySource: identity.source,
        }),
      }).execute();
      this.markOutboundSent();
    } finally {
      this.sendTracker.release(chatId, body);
    }
  }
}
