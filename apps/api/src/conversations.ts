import type { BeastDatabase, SensitiveDataCipher } from '@beast/database';
import {
  ConversationStateSchema,
  type ConversationDetail,
  type ConversationListItem,
  type ConversationListResponse,
} from '@beast/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const ListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  state: ConversationStateSchema.optional(),
});

const ParamsSchema = z.object({ id: z.string().uuid() });

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function decryptOrPlaceholder(cipher: SensitiveDataCipher, payload: string): string {
  try {
    return cipher.decrypt(payload);
  } catch {
    return '[Dato no disponible]';
  }
}

function customerLabel(cipher: SensitiveDataCipher, payload: string): string {
  const identifier = decryptOrPlaceholder(cipher, payload);
  return identifier.replace(/@(c\.us|lid)$/, '');
}

export async function registerConversationRoutes(
  app: FastifyInstance,
  db: BeastDatabase,
  cipher: SensitiveDataCipher,
): Promise<void> {
  app.get('/conversations', async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_QUERY', issues: parsed.error.issues });
    }

    const { page, pageSize, state } = parsed.data;
    let listQuery = db
      .selectFrom('conversations as conversation')
      .leftJoin('sellers as seller', 'seller.id', 'conversation.seller_id')
      .select([
        'conversation.id',
        'conversation.customer_number_encrypted',
        'conversation.state',
        'conversation.opened_at',
        'conversation.last_message_at',
        'seller.name as seller_name',
      ]);
    let countQuery = db.selectFrom('conversations').select((expression) =>
      expression.fn.countAll<number>().as('total'),
    );

    if (state) {
      listQuery = listQuery.where('conversation.state', '=', state);
      countQuery = countQuery.where('state', '=', state);
    }

    const [rows, countRow] = await Promise.all([
      listQuery
        .orderBy('conversation.last_message_at', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute(),
      countQuery.executeTakeFirstOrThrow(),
    ]);

    const ids = rows.map((row) => row.id);
    const countRows = ids.length
      ? await db
          .selectFrom('messages')
          .select(['conversation_id'])
          .select((expression) => expression.fn.countAll<number>().as('message_count'))
          .where('conversation_id', 'in', ids)
          .groupBy('conversation_id')
          .execute()
      : [];
    const counts = new Map(
      countRows.map((row) => [row.conversation_id, Number(row.message_count)]),
    );

    const response: ConversationListResponse = {
      items: rows.map(
        (row): ConversationListItem => ({
          id: row.id,
          customer: customerLabel(cipher, row.customer_number_encrypted),
          state: ConversationStateSchema.parse(row.state),
          sellerName: row.seller_name,
          messageCount: counts.get(row.id) ?? 0,
          openedAt: iso(row.opened_at),
          lastMessageAt: iso(row.last_message_at),
        }),
      ),
      page,
      pageSize,
      total: Number(countRow.total),
    };

    return response;
  });

  app.get('/conversations/:id', async (request, reply) => {
    const parsed = ParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_CONVERSATION_ID' });
    }

    const conversation = await db
      .selectFrom('conversations as conversation')
      .leftJoin('sellers as seller', 'seller.id', 'conversation.seller_id')
      .select([
        'conversation.id',
        'conversation.customer_number_encrypted',
        'conversation.state',
        'conversation.opened_at',
        'conversation.last_message_at',
        'seller.name as seller_name',
      ])
      .where('conversation.id', '=', parsed.data.id)
      .executeTakeFirst();

    if (!conversation) {
      return reply.code(404).send({ error: 'CONVERSATION_NOT_FOUND' });
    }

    const messages = await db
      .selectFrom('messages')
      .select(['id', 'direction', 'sender_type', 'body_encrypted', 'occurred_at'])
      .where('conversation_id', '=', conversation.id)
      .orderBy('occurred_at', 'asc')
      .execute();

    const response: ConversationDetail = {
      id: conversation.id,
      customer: customerLabel(cipher, conversation.customer_number_encrypted),
      state: ConversationStateSchema.parse(conversation.state),
      sellerName: conversation.seller_name,
      messageCount: messages.length,
      openedAt: iso(conversation.opened_at),
      lastMessageAt: iso(conversation.last_message_at),
      messages: messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        senderType: message.sender_type,
        body: decryptOrPlaceholder(cipher, message.body_encrypted),
        occurredAt: iso(message.occurred_at),
      })),
    };

    return response;
  });
}
