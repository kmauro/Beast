import { randomUUID } from 'node:crypto';
import type { BeastDatabase, SensitiveDataCipher } from '@beast/database';
import type { Message } from 'whatsapp-web.js';

export type MessageIngestionResult =
  | {
      outcome: 'stored';
      conversationId: string;
      messageId: string;
      identitySource: MessageIdentitySource;
    }
  | { outcome: 'duplicate'; messageId: string; identitySource: MessageIdentitySource }
  | { outcome: 'ignored'; reason: string };

export type MessageIdentitySource = 'serialized' | 'parts' | 'content-fallback';
export type OutboundSenderType = 'BOT' | 'SELLER';

export interface OutboundDeliveryAudit {
  action: string;
  entityType: string;
  entityId: string;
  after: Record<string, unknown>;
}

type RuntimeMessageId = {
  _serialized?: unknown;
  id?: unknown;
  fromMe?: unknown;
  remote?: unknown;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function serializeRemoteId(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;

  if (value && typeof value === 'object') {
    const serialized = nonEmptyString((value as { _serialized?: unknown })._serialized);
    if (serialized) return serialized;
  }

  return null;
}

export function resolveWhatsAppMessageIdentity(message: Message): {
  value: string;
  source: MessageIdentitySource;
} {
  const runtimeId = message.id as unknown as RuntimeMessageId | undefined;
  const serialized = nonEmptyString(runtimeId?._serialized);

  if (serialized) {
    return { value: serialized, source: 'serialized' };
  }

  const opaqueId = nonEmptyString(runtimeId?.id);
  const remoteId = serializeRemoteId(runtimeId?.remote) ?? (message.fromMe ? message.to : message.from);

  if (opaqueId) {
    const fromMe =
      typeof runtimeId?.fromMe === 'boolean' ? runtimeId.fromMe : message.fromMe;
    return {
      value: `${fromMe ? '1' : '0'}_${remoteId}_${opaqueId}`,
      source: 'parts',
    };
  }

  return {
    value: JSON.stringify({
      from: message.from,
      to: message.to,
      fromMe: message.fromMe,
      timestamp: message.timestamp,
      type: message.type,
      body: message.body,
    }),
    source: 'content-fallback',
  };
}

function isDirectChatId(value: string): boolean {
  return !value.endsWith('@broadcast') &&
    !value.endsWith('@g.us') &&
    !value.endsWith('@newsletter');
}

function isDirectTextMessage(message: Message): boolean {
  return (
    !message.fromMe &&
    message.type === 'chat' &&
    message.body.trim().length > 0 &&
    isDirectChatId(message.from)
  );
}

function isDirectOutboundTextMessage(message: Message): boolean {
  return message.fromMe && message.type === 'chat' && message.body.trim().length > 0 &&
    typeof message.to === 'string' && message.to.length > 0 && isDirectChatId(message.to);
}

async function isConfiguredSeller(
  db: BeastDatabase,
  cipher: SensitiveDataCipher,
  chatId: string,
): Promise<boolean> {
  const senderDigits = chatId.replace(/\D/g, '');
  if (!senderDigits) return false;
  const sellers = await db.selectFrom('sellers').select('whatsapp_number_encrypted').execute();
  return sellers.some((seller) => {
    try {
      return cipher.decrypt(seller.whatsapp_number_encrypted).replace(/\D/g, '') === senderDigits;
    } catch {
      return false;
    }
  });
}

export async function ingestInboundMessage(
  db: BeastDatabase,
  cipher: SensitiveDataCipher,
  message: Message,
): Promise<MessageIngestionResult> {
  if (!isDirectTextMessage(message)) {
    return { outcome: 'ignored', reason: 'El mensaje no es texto directo entrante' };
  }
  if (await isConfiguredSeller(db, cipher, message.from)) {
    return { outcome: 'ignored', reason: 'El remitente es un vendedor configurado' };
  }

  const identity = resolveWhatsAppMessageIdentity(message);
  const messageId = cipher.lookupHash(identity.value);
  const chatKey = cipher.lookupHash(message.from);

  return db.transaction().execute(async (transaction): Promise<MessageIngestionResult> => {
    const duplicate = await transaction
      .selectFrom('messages')
      .select('id')
      .where('whatsapp_message_id', '=', messageId)
      .executeTakeFirst();

    if (duplicate) {
      return { outcome: 'duplicate', messageId, identitySource: identity.source };
    }

    const occurredAt = new Date(message.timestamp * 1000);
    let conversation = await transaction
      .selectFrom('conversations')
      .select(['id', 'state', 'last_message_at', 'closed_at'])
      .where('whatsapp_chat_id', '=', chatKey)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    if (!conversation) {
      conversation = {
        id: randomUUID(),
        state: 'NEW',
        last_message_at: occurredAt,
        closed_at: null,
      };
      await transaction
        .insertInto('conversations')
        .values({
          id: conversation.id,
          whatsapp_chat_id: chatKey,
          customer_number_encrypted: cipher.encrypt(message.from),
          state: conversation.state,
          seller_id: null,
          handoff_reason: null,
          active_form_version_id: null,
          opened_at: occurredAt,
          last_message_at: occurredAt,
          assigned_at: null,
          closed_at: null,
        })
        .execute();
    } else {
      const closedAt = conversation.closed_at ? new Date(conversation.closed_at) : null;
      const reopened =
        conversation.state === 'CLOSED' && (!closedAt || occurredAt.getTime() > closedAt.getTime());
      const previousActivity = new Date(conversation.last_message_at);
      const lastMessageAt =
        occurredAt.getTime() > previousActivity.getTime() ? occurredAt : previousActivity;
      await transaction
        .updateTable('conversations')
        .set({
          state: reopened ? 'NEW' : conversation.state,
          last_message_at: lastMessageAt,
          ...(reopened
            ? {
                seller_id: null,
                handoff_reason: null,
                active_form_version_id: null,
                opened_at: occurredAt,
                assigned_at: null,
                closed_at: null,
              }
            : {}),
        })
        .where('id', '=', conversation.id)
        .execute();
    }

    await transaction
      .insertInto('messages')
      .values({
        id: randomUUID(),
        conversation_id: conversation.id,
        whatsapp_message_id: messageId,
        direction: 'INBOUND',
        sender_type: 'CUSTOMER',
        body_encrypted: cipher.encrypt(message.body),
        occurred_at: occurredAt,
      })
      .execute();

    return {
      outcome: 'stored',
      conversationId: conversation.id,
      messageId,
      identitySource: identity.source,
    };
  });
}

export async function ingestOutboundMessage(
  db: BeastDatabase,
  cipher: SensitiveDataCipher,
  message: Message,
  senderType: OutboundSenderType = 'SELLER',
  deliveryAudit: OutboundDeliveryAudit | null = null,
): Promise<MessageIngestionResult> {
  if (!isDirectOutboundTextMessage(message)) {
    return { outcome: 'ignored', reason: 'El mensaje no es texto directo saliente' };
  }

  const identity = resolveWhatsAppMessageIdentity(message);
  const messageId = cipher.lookupHash(identity.value);
  const chatKey = cipher.lookupHash(message.to);

  return db.transaction().execute(async (transaction): Promise<MessageIngestionResult> => {
    const duplicate = await transaction.selectFrom('messages').select('id')
      .where('whatsapp_message_id', '=', messageId).executeTakeFirst();
    if (duplicate) {
      if (deliveryAudit) {
        await transaction.insertInto('audit_log').values({
          actor_user_id: null,
          action: deliveryAudit.action,
          entity_type: deliveryAudit.entityType,
          entity_id: deliveryAudit.entityId,
          before_json: null,
          after_json: JSON.stringify({ ...deliveryAudit.after, whatsappMessageId: messageId }),
        }).execute();
      }
      return { outcome: 'duplicate', messageId, identitySource: identity.source };
    }

    const conversation = await transaction.selectFrom('conversations')
      .select(['id', 'last_message_at'])
      .where('whatsapp_chat_id', '=', chatKey)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (!conversation) {
      return { outcome: 'ignored', reason: 'No existe una conversación para el mensaje saliente' };
    }

    const occurredAt = new Date(message.timestamp * 1000);
    const previousActivity = new Date(conversation.last_message_at);
    await transaction.updateTable('conversations').set({
      last_message_at: occurredAt.getTime() > previousActivity.getTime() ? occurredAt : previousActivity,
    }).where('id', '=', conversation.id).execute();
    await transaction.insertInto('messages').values({
      id: randomUUID(),
      conversation_id: conversation.id,
      whatsapp_message_id: messageId,
      direction: 'OUTBOUND',
      sender_type: senderType,
      body_encrypted: cipher.encrypt(message.body),
      occurred_at: occurredAt,
    }).execute();
    if (deliveryAudit) {
      await transaction.insertInto('audit_log').values({
        actor_user_id: null,
        action: deliveryAudit.action,
        entity_type: deliveryAudit.entityType,
        entity_id: deliveryAudit.entityId,
        before_json: null,
        after_json: JSON.stringify({ ...deliveryAudit.after, whatsappMessageId: messageId }),
      }).execute();
    }

    return {
      outcome: 'stored',
      conversationId: conversation.id,
      messageId,
      identitySource: identity.source,
    };
  });
}
