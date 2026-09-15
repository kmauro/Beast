import {
  assertTransition,
  ConversationStateSchema,
  HandoffReasonSchema,
  nextSeller,
  type HandoffReason,
} from '@beast/shared';
import { randomUUID } from 'node:crypto';
import type { BeastDatabase } from './client.js';
import { enqueueJob } from './jobs.js';

export class AssignmentError extends Error {
  constructor(readonly code: 'CONVERSATION_NOT_FOUND' | 'NO_ACTIVE_SELLERS' | 'INVALID_STATE') {
    super(code);
  }
}

export interface AssignmentResult {
  conversationId: string;
  sellerId: string;
  sellerName: string;
  whatsappLabel: string;
  assignmentsInBatch: number;
  batchSize: number;
  summaryId: string | null;
}

export interface AssignmentSummary {
  textEncrypted: string;
  structuredDataEncrypted: string;
  modelName: string;
}

export async function assignConversationToNextSeller(
  db: BeastDatabase,
  conversationId: string,
  reason: HandoffReason,
  summary: AssignmentSummary | null = null,
): Promise<AssignmentResult> {
  const validatedReason = HandoffReasonSchema.parse(reason);
  return db.transaction().execute(async (transaction) => {
    const conversation = await transaction.selectFrom('conversations')
      .select(['id', 'state'])
      .where('id', '=', conversationId)
      .forUpdate()
      .executeTakeFirst();
    if (!conversation) throw new AssignmentError('CONVERSATION_NOT_FOUND');

    const state = ConversationStateSchema.parse(conversation.state);
    try {
      assertTransition(state, 'SELLER_ASSIGNED');
    } catch {
      throw new AssignmentError('INVALID_STATE');
    }

    const sellers = await transaction.selectFrom('sellers')
      .select(['id', 'name', 'whatsapp_label'])
      .where('active', '=', true)
      .orderBy('rotation_order', 'asc')
      .forUpdate()
      .execute();
    if (sellers.length === 0) throw new AssignmentError('NO_ACTIVE_SELLERS');

    const rotation = await transaction.selectFrom('seller_rotation')
      .selectAll()
      .where('id', '=', 1)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const next = nextSeller({
      activeSellerIds: sellers.map((seller) => seller.id),
      currentSellerId: rotation.current_seller_id,
      assignmentsInBatch: rotation.assignments_in_batch,
      batchSize: rotation.batch_size,
    });
    const seller = sellers.find((candidate) => candidate.id === next.sellerId)!;
    const assignedAt = new Date();
    const summaryId = summary ? randomUUID() : null;

    await transaction.updateTable('seller_rotation').set({
      current_seller_id: seller.id,
      assignments_in_batch: next.assignmentsInBatch,
    }).where('id', '=', 1).execute();
    await transaction.updateTable('conversations').set({
      state: 'SELLER_ASSIGNED',
      seller_id: seller.id,
      handoff_reason: validatedReason,
      assigned_at: assignedAt,
      closed_at: null,
    }).where('id', '=', conversation.id).execute();
    await enqueueJob(transaction, {
      jobType: 'APPLY_CONVERSATION_LABEL',
      deduplicationKey: `assignment-label:${conversation.id}:${seller.id}:${assignedAt.toISOString()}`,
      payload: { conversationId: conversation.id },
      maxAttempts: 10,
    });
    if (summary && summaryId) {
      const latestSummary = await transaction.selectFrom('summaries')
        .select('version_number')
        .where('conversation_id', '=', conversation.id)
        .orderBy('version_number', 'desc')
        .forUpdate()
        .executeTakeFirst();
      await transaction.insertInto('summaries').values({
        id: summaryId,
        conversation_id: conversation.id,
        version_number: (latestSummary?.version_number ?? 0) + 1,
        summary_text: summary.textEncrypted,
        structured_data: JSON.stringify({ encrypted: summary.structuredDataEncrypted }),
        model_name: summary.modelName,
      }).execute();
      await enqueueJob(transaction, {
        jobType: 'SEND_SELLER_SUMMARY',
        deduplicationKey: `seller-summary:${summaryId}`,
        payload: { conversationId: conversation.id, summaryId },
        maxAttempts: 10,
      });
    }
    await transaction.insertInto('audit_log').values({
      actor_user_id: null,
      action: 'CONVERSATION_ASSIGNED',
      entity_type: 'conversation',
      entity_id: conversation.id,
      before_json: JSON.stringify({ state }),
      after_json: JSON.stringify({
        state: 'SELLER_ASSIGNED',
        sellerId: seller.id,
        reason: validatedReason,
        assignmentsInBatch: next.assignmentsInBatch,
      }),
    }).execute();

    return {
      conversationId: conversation.id,
      sellerId: seller.id,
      sellerName: seller.name,
      whatsappLabel: seller.whatsapp_label,
      assignmentsInBatch: next.assignmentsInBatch,
      batchSize: rotation.batch_size,
      summaryId,
    };
  });
}
