import {
  AssignmentError,
  assignConversationToNextSeller,
  type BeastDatabase,
  type SensitiveDataCipher,
} from '@beast/database';
import {
  ConversationStateSchema,
  assertTransition,
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
const TransitionSchema = z.object({
  state: ConversationStateSchema,
  sellerId: z.string().uuid().nullable().optional(),
});
const AssignmentSchema = z.object({
  reason: z.enum(['QUALIFICATION_COMPLETE', 'HUMAN_REQUESTED', 'MODEL_UNCERTAIN'])
    .default('HUMAN_REQUESTED'),
});

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

  app.post('/conversations/:id/transition', async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params);
    const body = TransitionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'INVALID_TRANSITION' });
    }

    const current = await db.selectFrom('conversations')
      .select(['id', 'state', 'seller_id'])
      .where('id', '=', params.data.id)
      .executeTakeFirst();
    if (!current) return reply.code(404).send({ error: 'CONVERSATION_NOT_FOUND' });

    const currentState = ConversationStateSchema.parse(current.state);
    try {
      assertTransition(currentState, body.data.state);
    } catch {
      return reply.code(409).send({ error: 'TRANSITION_NOT_ALLOWED', from: currentState, to: body.data.state });
    }

    const sellerId = body.data.sellerId === undefined ? current.seller_id : body.data.sellerId;
    if (body.data.state === 'SELLER_ASSIGNED') {
      if (!sellerId) return reply.code(400).send({ error: 'SELLER_REQUIRED' });
      const seller = await db.selectFrom('sellers').select('id')
        .where('id', '=', sellerId).where('active', '=', true).executeTakeFirst();
      if (!seller) return reply.code(400).send({ error: 'ACTIVE_SELLER_REQUIRED' });
    }

    const result = await db.transaction().execute(async (transaction) => {
      const updated = await transaction.updateTable('conversations').set({
        state: body.data.state,
        seller_id: body.data.state === 'NEW' ? null : sellerId,
        closed_at: body.data.state === 'CLOSED' ? new Date() : null,
        ...(body.data.state === 'SELLER_ASSIGNED' ? { assigned_at: new Date() } : {}),
        ...(body.data.state === 'NEW' ? { assigned_at: null } : {}),
        ...(body.data.state === 'NEW' ? { handoff_reason: null, active_form_version_id: null } : {}),
      }).where('id', '=', current.id).where('state', '=', current.state).executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) return false;

      await transaction.insertInto('audit_log').values({
        actor_user_id: null,
        action: 'CONVERSATION_STATE_CHANGED',
        entity_type: 'conversation',
        entity_id: current.id,
        before_json: JSON.stringify({ state: currentState, sellerId: current.seller_id }),
        after_json: JSON.stringify({ state: body.data.state, sellerId }),
      }).execute();
      return true;
    });

    if (!result) return reply.code(409).send({ error: 'CONVERSATION_CHANGED_CONCURRENTLY' });
    return reply.code(204).send();
  });

  app.post('/conversations/:id/assign', async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params);
    const body = AssignmentSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_ASSIGNMENT' });
    try {
      return await assignConversationToNextSeller(db, params.data.id, body.data.reason);
    } catch (error) {
      if (error instanceof AssignmentError) {
        const status = error.code === 'CONVERSATION_NOT_FOUND' ? 404 : 409;
        return reply.code(status).send({ error: error.code });
      }
      throw error;
    }
  });
}
