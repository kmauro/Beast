import { randomUUID } from 'node:crypto';
import {
  enqueueJob,
  type BeastDatabase,
  type SensitiveDataCipher,
} from '@beast/database';
import type { FormFieldType, HandoffReason } from '@beast/shared';
import type { WorkerConfig } from './config.js';
import { OllamaClient, type QualificationAnalysis } from './ollama.js';

interface AnalysisJobPayload {
  conversationId: string;
  triggerMessageId: string;
}

interface CatalogField {
  id: string;
  key: string;
  label: string;
  question: string;
  type: FormFieldType;
  required: boolean;
  essential: boolean;
  options: string[];
  visibleWhen: { fieldKey: string; operator: 'EQUALS' | 'NOT_EQUALS' | 'CONTAINS'; value: unknown } | null;
}

interface CatalogService {
  id: string;
  code: string;
  name: string;
  formVersionId: string | null;
  fields: CatalogField[];
}

interface StoredAnswer {
  fieldId: string;
  key: string;
  value: unknown;
  confidence: number;
  confirmed: boolean;
}

export interface AnalysisOutcome {
  status: 'processed' | 'stale' | 'skipped';
  serviceCode: string | null;
  missingFieldKeys: string[];
  confidence: number;
  handoffReason: HandoffReason | null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function booleanValue(value: boolean | number): boolean {
  return value === true || value === 1;
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

function normalizeChoice(value: string, options: string[]): string | null {
  const normalized = value.trim().toLocaleLowerCase('es-AR');
  return options.find((option) => option.trim().toLocaleLowerCase('es-AR') === normalized) ?? null;
}

function normalizeFieldValue(field: CatalogField, value: unknown): unknown | null {
  if (value === null || value === undefined) return null;
  if (field.type === 'TEXT' || field.type === 'LONG_TEXT') {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 4000) : null;
  }
  if (field.type === 'INTEGER') {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(numeric) ? numeric : null;
  }
  if (field.type === 'BOOLEAN') {
    return typeof value === 'boolean' ? value : null;
  }
  if (field.type === 'SINGLE_CHOICE') {
    return typeof value === 'string' ? normalizeChoice(value, field.options) : null;
  }
  if (!Array.isArray(value)) return null;
  const choices = value.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const choice = normalizeChoice(item, field.options);
    return choice ? [choice] : [];
  });
  return choices.length > 0 ? [...new Set(choices)] : null;
}

function conditionMatches(
  condition: CatalogField['visibleWhen'],
  answers: Map<string, StoredAnswer>,
): boolean {
  if (!condition) return true;
  const actual = answers.get(condition.fieldKey)?.value;
  if (condition.operator === 'CONTAINS') {
    return Array.isArray(actual)
      ? actual.some((item) => item === condition.value)
      : typeof actual === 'string' && actual.includes(String(condition.value));
  }
  const equal = actual === condition.value;
  return condition.operator === 'EQUALS' ? equal : !equal;
}

function roundedConfidence(scores: number[]): number {
  if (scores.length === 0) return 0;
  return Math.round((scores.reduce((total, score) => total + score, 0) / scores.length) * 1000) / 1000;
}

async function loadCatalog(db: BeastDatabase): Promise<CatalogService[]> {
  const [services, versions] = await Promise.all([
    db.selectFrom('service_catalog').select(['id', 'code', 'name'])
      .where('active', '=', true).orderBy('display_order', 'asc').execute(),
    db.selectFrom('form_versions as version')
      .innerJoin('form_templates as template', 'template.id', 'version.template_id')
      .select(['version.id', 'version.published_at', 'template.service_id'])
      .where('version.status', '=', 'PUBLISHED')
      .where('template.active', '=', true)
      .orderBy('version.published_at', 'desc')
      .execute(),
  ]);
  const selectedVersions = new Map<string, string>();
  for (const version of versions) {
    if (!selectedVersions.has(version.service_id)) selectedVersions.set(version.service_id, version.id);
  }
  const versionIds = [...selectedVersions.values()];
  const fields = versionIds.length === 0 ? [] : await db.selectFrom('form_fields').selectAll()
    .where('form_version_id', 'in', versionIds).orderBy('display_order', 'asc').execute();

  return services.map((service) => {
    const formVersionId = selectedVersions.get(service.id) ?? null;
    return {
      id: service.id,
      code: service.code,
      name: service.name,
      formVersionId,
      fields: fields.filter((field) => field.form_version_id === formVersionId).map((field) => ({
        id: field.id,
        key: field.field_key,
        label: field.label,
        question: field.question,
        type: field.field_type,
        required: booleanValue(field.required),
        essential: booleanValue(field.essential),
        options: parseJson<string[]>(field.options_json, []),
        visibleWhen: parseJson<CatalogField['visibleWhen']>(field.visible_when_json, null),
      })),
    };
  });
}

async function loadFieldsForVersion(
  db: BeastDatabase,
  formVersionId: string,
): Promise<CatalogField[]> {
  const fields = await db.selectFrom('form_fields').selectAll()
    .where('form_version_id', '=', formVersionId).orderBy('display_order', 'asc').execute();
  return fields.map((field) => ({
    id: field.id,
    key: field.field_key,
    label: field.label,
    question: field.question,
    type: field.field_type,
    required: booleanValue(field.required),
    essential: booleanValue(field.essential),
    options: parseJson<string[]>(field.options_json, []),
    visibleWhen: parseJson<CatalogField['visibleWhen']>(field.visible_when_json, null),
  }));
}

async function loadAnswers(
  db: BeastDatabase,
  cipher: SensitiveDataCipher,
  conversationId: string,
  formVersionId: string | null,
): Promise<Map<string, StoredAnswer>> {
  if (!formVersionId) return new Map();
  const rows = await db.selectFrom('form_answers as answer')
    .innerJoin('form_fields as field', 'field.id', 'answer.form_field_id')
    .select([
      'answer.form_field_id',
      'answer.value_json',
      'answer.confidence',
      'answer.confirmed_by_customer',
      'field.field_key',
    ])
    .where('answer.conversation_id', '=', conversationId)
    .where('field.form_version_id', '=', formVersionId)
    .execute();
  return new Map(rows.map((row) => [row.field_key, {
    fieldId: row.form_field_id,
    key: row.field_key,
    value: decryptAnswer(cipher, row.value_json),
    confidence: Number(row.confidence ?? 0),
    confirmed: booleanValue(row.confirmed_by_customer),
  }]));
}

function replyFor(
  analysis: QualificationAnalysis,
  service: CatalogService | null,
  missing: CatalogField[],
  services: CatalogService[],
  state: string,
  firstBotReply: boolean,
  handoffReason: HandoffReason | null,
): string {
  let reply: string;
  if (handoffReason === 'HUMAN_REQUESTED') {
    reply = 'Voy a derivar tu consulta a un vendedor para que continúe la conversación.';
  } else if (handoffReason === 'MODEL_UNCERTAIN') {
    reply = 'Necesito que un vendedor revise tu consulta para asesorarte correctamente. Ya la estoy derivando.';
  } else if (handoffReason === 'QUALIFICATION_COMPLETE') {
    reply = 'Gracias, ya tengo la información necesaria. Un vendedor va a continuar la conversación.';
  } else if (!service) {
    reply = `¿Cuál de estos servicios necesitás? ${services.map((item) => item.name).join(', ')}.`;
  } else if (missing[0]) {
    reply = missing[0].question;
  } else {
    reply = analysis.reply.trim() || '¿Podés contarme un poco más sobre lo que necesitás?';
  }
  if (state === 'OUT_OF_HOURS' && firstBotReply) {
    return `En este momento estamos fuera del horario comercial. ${reply} Retomaremos la atención cuando vuelva a abrir el negocio.`;
  }
  return reply;
}

export class QualificationProcessor {
  constructor(
    private readonly db: BeastDatabase,
    private readonly cipher: SensitiveDataCipher,
    private readonly config: WorkerConfig,
    private readonly ollama: OllamaClient,
  ) {}

  async process(payload: AnalysisJobPayload): Promise<AnalysisOutcome> {
    const conversation = await this.db.selectFrom('conversations')
      .select(['id', 'state', 'active_form_version_id'])
      .where('id', '=', payload.conversationId).executeTakeFirst();
    if (!conversation || ['CLOSED', 'SELLER_ASSIGNED', 'PENDING_FOLLOW_UP'].includes(conversation.state)) {
      return { status: 'skipped', serviceCode: null, missingFieldKeys: [], confidence: 0, handoffReason: null };
    }

    const latestInbound = await this.db.selectFrom('messages')
      .select(['id', 'whatsapp_message_id'])
      .where('conversation_id', '=', conversation.id)
      .where('direction', '=', 'INBOUND')
      .orderBy('occurred_at', 'desc').orderBy('created_at', 'desc').executeTakeFirst();
    if (!latestInbound || latestInbound.whatsapp_message_id !== payload.triggerMessageId) {
      return { status: 'stale', serviceCode: null, missingFieldKeys: [], confidence: 0, handoffReason: null };
    }

    const catalog = await loadCatalog(this.db);
    if (catalog.length === 0) throw new Error('No hay servicios activos configurados');
    const currentServiceRow = await this.db.selectFrom('conversation_services as selected')
      .innerJoin('service_catalog as service', 'service.id', 'selected.service_id')
      .select(['service.id', 'service.code'])
      .where('selected.conversation_id', '=', conversation.id)
      .where('selected.primary_service', '=', true)
      .executeTakeFirst();
    let currentService = currentServiceRow
      ? catalog.find((service) => service.id === currentServiceRow.id) ?? null
      : null;
    if (currentService && conversation.active_form_version_id &&
      currentService.formVersionId !== conversation.active_form_version_id) {
      currentService = {
        ...currentService,
        formVersionId: conversation.active_form_version_id,
        fields: await loadFieldsForVersion(this.db, conversation.active_form_version_id),
      };
    }
    const currentAnswers = await loadAnswers(
      this.db,
      this.cipher,
      conversation.id,
      currentService?.formVersionId ?? conversation.active_form_version_id,
    );
    const messageRows = await this.db.selectFrom('messages')
      .select(['direction', 'body_encrypted'])
      .where('conversation_id', '=', conversation.id)
      .orderBy('occurred_at', 'desc')
      .limit(this.config.MODEL_CONTEXT_MESSAGES)
      .execute();
    let remainingCharacters = this.config.MODEL_CONTEXT_MAX_CHARS;
    const newestFirstMessages = messageRows.flatMap((message) => {
      if (remainingCharacters <= 0) return [];
      try {
        const decrypted = this.cipher.decrypt(message.body_encrypted);
        const content = decrypted.slice(-remainingCharacters);
        remainingCharacters -= content.length;
        return [{
          role: message.direction === 'INBOUND' ? 'customer' as const : 'business' as const,
          content,
        }];
      } catch {
        return [];
      }
    });
    const messages = newestFirstMessages.reverse();

    const analysis = await this.ollama.analyze({
      state: conversation.state,
      services: catalog.map((service) => ({
        code: service.code,
        name: service.name,
        fields: service.fields.map((field) => ({
          key: field.key,
          question: field.question,
          type: field.type,
          required: field.required,
          essential: field.essential,
          options: field.options,
        })),
      })),
      existingAnswers: Object.fromEntries(
        [...currentAnswers.values()].map((answer) => [answer.key, answer.value]),
      ),
      messages,
    });

    const proposedService = analysis.serviceCode
      ? catalog.find((service) => service.code === analysis.serviceCode) ?? null
      : null;
    const service = currentService ?? proposedService;
    const acceptedAnswers = new Map<string, { value: unknown; confidence: number; confirmed: boolean }>();
    if (service?.formVersionId) {
      for (const answer of analysis.answers) {
        const field = service.fields.find((candidate) => candidate.key === answer.fieldKey);
        if (!field || answer.confidence < this.config.MODEL_MIN_FIELD_CONFIDENCE) continue;
        const existing = currentAnswers.get(field.key);
        if (existing && ((existing.confirmed && !answer.confirmed) ||
          (!answer.confirmed && existing.confidence > answer.confidence))) continue;
        const value = normalizeFieldValue(field, answer.value);
        if (value !== null) acceptedAnswers.set(field.key, {
          value,
          confidence: answer.confidence,
          confirmed: answer.confirmed,
        });
      }
    }

    return this.db.transaction().execute(async (transaction): Promise<AnalysisOutcome> => {
      const lockedConversation = await transaction.selectFrom('conversations')
        .select(['state']).where('id', '=', conversation.id).forUpdate().executeTakeFirst();
      const stillLatest = await transaction.selectFrom('messages').select('whatsapp_message_id')
        .where('conversation_id', '=', conversation.id).where('direction', '=', 'INBOUND')
        .orderBy('occurred_at', 'desc').orderBy('created_at', 'desc').executeTakeFirst();
      if (!lockedConversation || !stillLatest || stillLatest.whatsapp_message_id !== payload.triggerMessageId ||
        ['CLOSED', 'SELLER_ASSIGNED', 'PENDING_FOLLOW_UP'].includes(lockedConversation.state)) {
        return { status: 'stale', serviceCode: null, missingFieldKeys: [], confidence: 0, handoffReason: null };
      }

      if (service) {
        await transaction.updateTable('conversation_services').set({ primary_service: false })
          .where('conversation_id', '=', conversation.id).execute();
        await transaction.insertInto('conversation_services').values({
          conversation_id: conversation.id,
          service_id: service.id,
          primary_service: true,
        }).onDuplicateKeyUpdate({ primary_service: true }).execute();
        await transaction.updateTable('conversations').set({
          active_form_version_id: service.formVersionId,
        }).where('id', '=', conversation.id).execute();
      }

      if (service?.formVersionId) {
        for (const [fieldKey, accepted] of acceptedAnswers) {
          const field = service.fields.find((candidate) => candidate.key === fieldKey)!;
          await transaction.insertInto('form_answers').values({
            id: randomUUID(),
            conversation_id: conversation.id,
            form_field_id: field.id,
            value_json: JSON.stringify({ encrypted: this.cipher.encrypt(JSON.stringify(accepted.value)) }),
            confidence: accepted.confidence,
            source_message_id: latestInbound.id,
            confirmed_by_customer: accepted.confirmed,
          }).onDuplicateKeyUpdate({
            value_json: JSON.stringify({ encrypted: this.cipher.encrypt(JSON.stringify(accepted.value)) }),
            confidence: accepted.confidence,
            source_message_id: latestInbound.id,
            confirmed_by_customer: accepted.confirmed,
          }).execute();
        }
      }

      const persistedAnswers = await loadAnswers(
        transaction,
        this.cipher,
        conversation.id,
        service?.formVersionId ?? null,
      );
      const missing = service?.fields.filter((field) =>
        field.required && (lockedConversation.state !== 'OUT_OF_HOURS' || field.essential) &&
        conditionMatches(field.visibleWhen, persistedAnswers) &&
        !persistedAnswers.has(field.key),
      ) ?? [];
      const evidenceScores = [
        ...(service ? [analysis.serviceConfidence] : []),
        ...[...persistedAnswers.values()].map((answer) => answer.confidence),
        analysis.overallConfidence,
      ];
      const confidence = roundedConfidence(evidenceScores);
      const invalidService = analysis.serviceCode !== null && !proposedService;
      const needsHuman = analysis.humanRequested || analysis.needsHuman || invalidService ||
        (service !== null && (!service.formVersionId || confidence < this.config.MODEL_MIN_CONFIDENCE));
      let handoffReason: HandoffReason | null = null;
      if (analysis.humanRequested) handoffReason = 'HUMAN_REQUESTED';
      else if (needsHuman) handoffReason = 'MODEL_UNCERTAIN';
      else if (service && missing.length === 0) handoffReason = 'QUALIFICATION_COMPLETE';

      if (handoffReason === 'QUALIFICATION_COMPLETE' && lockedConversation.state !== 'READY_FOR_HANDOFF') {
        await transaction.updateTable('conversations').set({ state: 'READY_FOR_HANDOFF' })
          .where('id', '=', conversation.id).where('state', '=', lockedConversation.state).execute();
      }

      const firstBotReply = !(await transaction.selectFrom('messages').select('id')
        .where('conversation_id', '=', conversation.id).where('sender_type', '=', 'BOT')
        .executeTakeFirst());
      const body = replyFor(
        analysis,
        service,
        missing,
        catalog,
        lockedConversation.state,
        firstBotReply,
        handoffReason,
      );
      if (this.config.BOT_REPLY_ENABLED) {
        await enqueueJob(transaction, {
          jobType: 'SEND_CUSTOMER_MESSAGE',
          deduplicationKey: `customer-reply:${payload.triggerMessageId}`,
          payload: {
            conversationId: conversation.id,
            triggerMessageId: payload.triggerMessageId,
            bodyEncrypted: this.cipher.encrypt(body),
          },
        });
      }
      if (handoffReason) {
        await enqueueJob(transaction, {
          jobType: 'HANDOFF_CONVERSATION',
          deduplicationKey: `handoff:${conversation.id}:${payload.triggerMessageId}`,
          payload: {
            conversationId: conversation.id,
            triggerMessageId: payload.triggerMessageId,
            reason: handoffReason,
            confidence,
            modelSummaryEncrypted: this.cipher.encrypt(analysis.summary),
          },
        });
      }
      await enqueueJob(transaction, {
        jobType: 'APPLY_CONVERSATION_LABEL',
        deduplicationKey: `analysis-label:${conversation.id}:${payload.triggerMessageId}`,
        payload: { conversationId: conversation.id },
        maxAttempts: 10,
      });
      await transaction.insertInto('audit_log').values({
        actor_user_id: null,
        action: 'CONVERSATION_ANALYZED',
        entity_type: 'conversation',
        entity_id: conversation.id,
        before_json: null,
        after_json: JSON.stringify({
          serviceCode: service?.code ?? null,
          missingFieldKeys: missing.map((field) => field.key),
          confidence,
          handoffReason,
          triggerMessageId: payload.triggerMessageId,
        }),
      }).execute();

      return {
        status: 'processed',
        serviceCode: service?.code ?? null,
        missingFieldKeys: missing.map((field) => field.key),
        confidence,
        handoffReason,
      };
    });
  }
}
