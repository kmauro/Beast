import { enqueueJob, type BeastDatabase, type SensitiveDataCipher } from '@beast/database';
import { ConversationStateSchema, type ConversationState } from '@beast/shared';
import type whatsapp from 'whatsapp-web.js';
import type { WorkerConfig } from './config.js';

type WhatsAppClient = whatsapp.Client;
type WhatsAppLabel = whatsapp.Label;
type WhatsAppLabelId = string | number;

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== 'Error'
      ? `${error.name}: ${error.message}`
      : error.message;
  }
  return String(error);
}

function chatIdKind(chatId: string): string {
  if (chatId.endsWith('@lid')) return '@lid';
  if (chatId.endsWith('@c.us')) return '@c.us';
  return 'desconocido';
}

function normalized(value: string): string {
  return value.trim().toLocaleUpperCase('es-AR');
}

function expectedSystemLabel(state: ConversationState, config: WorkerConfig): string | null {
  if (state === 'NEW') return config.LABEL_NEW;
  if (state === 'BOT_QUALIFYING' || state === 'READY_FOR_HANDOFF') return config.LABEL_BOT;
  if (state === 'OUT_OF_HOURS') return config.LABEL_OUT_OF_HOURS;
  if (state === 'CLOSED') return config.LABEL_CLOSED;
  return null;
}

function directChatId(chat: whatsapp.Chat): string | null {
  const id = chat.id?._serialized;
  if (!id || id.endsWith('@g.us') || id.endsWith('@broadcast') || id.endsWith('@newsletter')) return null;
  return id;
}

export class WhatsAppLabelManager {
  private operations = Promise.resolve();

  constructor(
    private readonly client: WhatsAppClient,
    private readonly db: BeastDatabase,
    private readonly cipher: SensitiveDataCipher,
    private readonly config: WorkerConfig,
  ) {}

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }

  private async labelsAndManagedNames(): Promise<{
    labels: WhatsAppLabel[];
    managedNames: Set<string>;
  }> {
    const [labels, sellers] = await Promise.all([
      this.client.getLabels(),
      this.db.selectFrom('sellers').select('whatsapp_label').execute(),
    ]);
    return {
      labels,
      managedNames: new Set([
        this.config.LABEL_NEW,
        this.config.LABEL_BOT,
        this.config.LABEL_OUT_OF_HOURS,
        this.config.LABEL_CLOSED,
        ...sellers.map((seller) => seller.whatsapp_label),
      ].map(normalized)),
    };
  }

  private async cachedChatLabelIds(chatId: string): Promise<WhatsAppLabelId[]> {
    const page = this.client.pupPage;
    if (!page) throw new Error('La página de WhatsApp todavía no está disponible');

    try {
      const result = await page.evaluate((targetChatId) => {
        type BrowserChat = {
          id?: { _serialized?: string };
          labels?: Array<string | number>;
        };
        type WhatsAppCollections = {
          Chat: { getModelsArray(): BrowserChat[] };
        };
        const runtime = globalThis as unknown as {
          require(name: 'WAWebCollections'): WhatsAppCollections;
        };
        const chat = runtime.require('WAWebCollections').Chat.getModelsArray()
          .find((candidate) => candidate.id?._serialized === targetChatId);
        return chat ? [...(chat.labels ?? [])] : null;
      }, chatId);

      if (!result) {
        throw new Error('El chat no está cargado en la colección local de WhatsApp');
      }
      return result;
    } catch (error) {
      throw new Error(
        `No se pudieron leer las etiquetas del chat ${chatIdKind(chatId)}: ${errorDetail(error)}`,
        { cause: error },
      );
    }
  }

  applyConversationLabel(conversationId: string, force = false): Promise<void> {
    return this.serialized(() => this.applyConversationLabelUnlocked(conversationId, force));
  }

  private async applyConversationLabelUnlocked(conversationId: string, force: boolean): Promise<void> {
    const conversation = await this.db.selectFrom('conversations as conversation')
      .leftJoin('sellers as seller', 'seller.id', 'conversation.seller_id')
      .select([
        'conversation.id',
        'conversation.state',
        'conversation.customer_number_encrypted',
        'seller.whatsapp_label as seller_label',
      ])
      .where('conversation.id', '=', conversationId)
      .executeTakeFirst();
    if (!conversation) return;

    const state = ConversationStateSchema.parse(conversation.state);
    const expectedName = state === 'SELLER_ASSIGNED' || state === 'PENDING_FOLLOW_UP'
      ? conversation.seller_label
      : expectedSystemLabel(state, this.config);
    if (!expectedName) throw new Error(`No hay etiqueta definida para el estado ${state}`);

    const chatId = this.cipher.decrypt(conversation.customer_number_encrypted);
    const { labels, managedNames } = await this.labelsAndManagedNames();
    const expected = labels.find((label) => normalized(label.name) === normalized(expectedName));
    if (!expected) throw new Error(`La etiqueta de WhatsApp "${expectedName}" no existe`);
    const currentIds = await this.cachedChatLabelIds(chatId);
    const labelById = new Map(labels.map((label) => [String(label.id), label]));
    const managedIds = new Set(labels
      .filter((label) => managedNames.has(normalized(label.name)))
      .map((label) => String(label.id)));
    const closedLabel = labels.find((label) =>
      normalized(label.name) === normalized(this.config.LABEL_CLOSED));
    const manuallyClosed = closedLabel
      ? currentIds.some((id) => String(id) === String(closedLabel.id))
      : false;
    if (!force && state !== 'CLOSED' && manuallyClosed) {
      await this.db.transaction().execute(async (transaction) => {
        const result = await transaction.updateTable('conversations').set({
          state: 'CLOSED',
          closed_at: new Date(),
        }).where('id', '=', conversation.id).where('state', '=', conversation.state).executeTakeFirst();
        if (Number(result.numUpdatedRows) !== 1) return;
        await transaction.insertInto('audit_log').values({
          actor_user_id: null,
          action: 'WHATSAPP_CLOSED_LABEL_IMPORTED',
          entity_type: 'conversation',
          entity_id: conversation.id,
          before_json: JSON.stringify({ state }),
          after_json: JSON.stringify({ state: 'CLOSED', label: this.config.LABEL_CLOSED }),
        }).execute();
      });
      return;
    }
    const desiredIds = currentIds.filter((id) => !managedIds.has(String(id)));
    desiredIds.push(expected.id);
    const currentIdStrings = [...new Set(currentIds.map(String))].sort();
    const nextIds = [...new Set(desiredIds.map(String))].sort();
    if (currentIdStrings.join(',') === nextIds.join(',')) return;

    await this.client.addOrRemoveLabels(desiredIds, [chatId]);
    await this.db.insertInto('audit_log').values({
      actor_user_id: null,
      action: 'WHATSAPP_LABEL_APPLIED',
      entity_type: 'conversation',
      entity_id: conversation.id,
      before_json: JSON.stringify({
        labels: currentIds.map((id) => labelById.get(String(id))?.name ?? `[${String(id)}]`),
      }),
      after_json: JSON.stringify({ label: expected.name, state }),
    }).execute();
  }

  synchronizeManualLabels(): Promise<{ closed: number; assigned: number; missingClosedLabel: boolean }> {
    return this.serialized(() => this.synchronizeManualLabelsUnlocked());
  }

  private async synchronizeManualLabelsUnlocked(): Promise<{
    closed: number;
    assigned: number;
    missingClosedLabel: boolean;
  }> {
    const { labels } = await this.labelsAndManagedNames();
    const closedLabel = labels.find((label) => normalized(label.name) === normalized(this.config.LABEL_CLOSED));
    if (!closedLabel) return { closed: 0, assigned: 0, missingClosedLabel: true };

    const closedChats = await this.client.getChatsByLabelId(String(closedLabel.id));
    const closedChatIds = new Set(closedChats.flatMap((chat) => {
      const id = directChatId(chat);
      return id ? [id] : [];
    }));
    let closed = 0;
    for (const chatId of closedChatIds) {
      const chatKey = this.cipher.lookupHash(chatId);
      const changed = await this.db.transaction().execute(async (transaction) => {
        const conversation = await transaction.selectFrom('conversations')
          .select(['id', 'state', 'last_message_at']).where('whatsapp_chat_id', '=', chatKey)
          .orderBy('created_at', 'desc').forUpdate().executeTakeFirst();
        if (!conversation || conversation.state === 'CLOSED') return false;
        const reopenGraceMs = Math.max(30_000, this.config.LABEL_SYNC_INTERVAL_MS * 2);
        if (Date.now() - new Date(conversation.last_message_at).getTime() < reopenGraceMs) return false;
        await transaction.updateTable('conversations').set({
          state: 'CLOSED',
          closed_at: new Date(),
        }).where('id', '=', conversation.id).execute();
        await transaction.insertInto('audit_log').values({
          actor_user_id: null,
          action: 'WHATSAPP_CLOSED_LABEL_IMPORTED',
          entity_type: 'conversation',
          entity_id: conversation.id,
          before_json: JSON.stringify({ state: conversation.state }),
          after_json: JSON.stringify({ state: 'CLOSED', label: closedLabel.name }),
        }).execute();
        return true;
      });
      if (changed) closed += 1;
    }

    const sellers = await this.db.selectFrom('sellers')
      .select(['id', 'whatsapp_label']).where('active', '=', true)
      .orderBy('rotation_order', 'asc').execute();
    const sellerChats = new Map<string, typeof sellers>();
    for (const seller of sellers) {
      const label = labels.find((candidate) => normalized(candidate.name) === normalized(seller.whatsapp_label));
      if (!label) continue;
      const chats = await this.client.getChatsByLabelId(String(label.id));
      for (const chat of chats) {
        const chatId = directChatId(chat);
        if (!chatId || closedChatIds.has(chatId)) continue;
        sellerChats.set(chatId, [...(sellerChats.get(chatId) ?? []), seller]);
      }
    }
    let assigned = 0;
    for (const [chatId, candidates] of sellerChats) {
      const chatKey = this.cipher.lookupHash(chatId);
      const changed = await this.db.transaction().execute(async (transaction) => {
        const conversation = await transaction.selectFrom('conversations')
          .select(['id', 'state', 'seller_id', 'assigned_at'])
          .where('whatsapp_chat_id', '=', chatKey)
          .orderBy('created_at', 'desc').forUpdate().executeTakeFirst();
        if (!conversation || conversation.state === 'CLOSED') return false;
        if (candidates.length !== 1) {
          const sellerIds = candidates.map((candidate) => candidate.id).sort();
          const latestConflict = await transaction.selectFrom('audit_log')
            .select('after_json')
            .where('action', '=', 'WHATSAPP_SELLER_LABEL_CONFLICT')
            .where('entity_type', '=', 'conversation')
            .where('entity_id', '=', conversation.id)
            .orderBy('created_at', 'desc')
            .executeTakeFirst();
          const currentConflict = JSON.stringify({ sellerIds });
          if (latestConflict?.after_json !== currentConflict) {
            await transaction.insertInto('audit_log').values({
              actor_user_id: null,
              action: 'WHATSAPP_SELLER_LABEL_CONFLICT',
              entity_type: 'conversation',
              entity_id: conversation.id,
              before_json: null,
              after_json: currentConflict,
            }).execute();
          }
          return false;
        }
        const seller = candidates[0]!;
        if (conversation.state === 'SELLER_ASSIGNED' && conversation.seller_id === seller.id) return false;
        await transaction.updateTable('conversations').set({
          state: 'SELLER_ASSIGNED',
          seller_id: seller.id,
          handoff_reason: 'HUMAN_REQUESTED',
          assigned_at: conversation.seller_id === seller.id && conversation.assigned_at
            ? conversation.assigned_at
            : new Date(),
          closed_at: null,
        }).where('id', '=', conversation.id).execute();
        await enqueueJob(transaction, {
          jobType: 'APPLY_CONVERSATION_LABEL',
          deduplicationKey: `manual-seller-label:${conversation.id}:${seller.id}:${Date.now()}`,
          payload: { conversationId: conversation.id },
          maxAttempts: 10,
        });
        await transaction.insertInto('audit_log').values({
          actor_user_id: null,
          action: 'WHATSAPP_SELLER_LABEL_IMPORTED',
          entity_type: 'conversation',
          entity_id: conversation.id,
          before_json: JSON.stringify({ state: conversation.state, sellerId: conversation.seller_id }),
          after_json: JSON.stringify({ state: 'SELLER_ASSIGNED', sellerId: seller.id }),
        }).execute();
        return true;
      });
      if (changed) assigned += 1;
    }

    return { closed, assigned, missingClosedLabel: false };
  }
}
