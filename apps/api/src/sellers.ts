import { randomUUID } from 'node:crypto';
import type { BeastDatabase, SensitiveDataCipher } from '@beast/database';
import type { SellerItem } from '@beast/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

const IdParamsSchema = z.object({ id: z.string().uuid() });
const SellerSchema = z.object({
  name: z.string().trim().min(1).max(160),
  whatsappNumber: z.string().trim().min(8).max(40),
  whatsappLabel: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,99}$/).optional(),
  active: z.boolean().default(true),
});
const ReorderSchema = z.object({ sellerIds: z.array(z.string().uuid()).min(1).max(100) });

function normalizeNumber(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function toBoolean(value: boolean | number): boolean {
  return value === true || value === 1;
}

function decryptNumber(cipher: SensitiveDataCipher, value: string): string {
  try {
    return `+${cipher.decrypt(value).replace(/\D/g, '')}`;
  } catch {
    return '[No disponible]';
  }
}

function duplicateEntry(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'ER_DUP_ENTRY';
}

async function audit(db: BeastDatabase, action: string, id: string, after: unknown): Promise<void> {
  await db.insertInto('audit_log').values({
    actor_user_id: null,
    action,
    entity_type: 'seller',
    entity_id: id,
    before_json: null,
    after_json: JSON.stringify(after),
  }).execute();
}

export async function registerSellerRoutes(
  app: FastifyInstance,
  db: BeastDatabase,
  cipher: SensitiveDataCipher,
): Promise<void> {
  app.get('/sellers', async () => {
    const sellers = await db.selectFrom('sellers').selectAll().orderBy('rotation_order').execute();
    return sellers.map((seller): SellerItem => ({
      id: seller.id,
      name: seller.name,
      whatsappNumber: decryptNumber(cipher, seller.whatsapp_number_encrypted),
      whatsappLabel: seller.whatsapp_label,
      rotationOrder: seller.rotation_order,
      active: toBoolean(seller.active),
    }));
  });

  app.post('/sellers', async (request, reply) => {
    const parsed = SellerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_SELLER', issues: parsed.error.issues });
    const number = normalizeNumber(parsed.data.whatsappNumber);
    if (!number) return reply.code(400).send({ error: 'INVALID_WHATSAPP_NUMBER' });

    const maximum = await db.selectFrom('sellers').select((expression) =>
      expression.fn.max<number>('rotation_order').as('maximum'),
    ).executeTakeFirst();
    const rotationOrder = Number(maximum?.maximum ?? 0) + 1;
    const id = randomUUID();
    const whatsappLabel = parsed.data.whatsappLabel ?? `VENDEDOR_${rotationOrder}`;

    try {
      await db.transaction().execute(async (transaction) => {
        await transaction.insertInto('sellers').values({
          id,
          name: parsed.data.name,
          whatsapp_number_encrypted: cipher.encrypt(number),
          whatsapp_label: whatsappLabel,
          rotation_order: rotationOrder,
          active: parsed.data.active,
        }).execute();
        await transaction.insertInto('audit_log').values({
          actor_user_id: null,
          action: 'SELLER_CREATED',
          entity_type: 'seller',
          entity_id: id,
          before_json: null,
          after_json: JSON.stringify({ name: parsed.data.name, whatsappLabel, rotationOrder }),
        }).execute();
      });
    } catch (error) {
      if (duplicateEntry(error)) return reply.code(409).send({ error: 'SELLER_LABEL_OR_ORDER_EXISTS' });
      throw error;
    }

    return reply.code(201).send({ id });
  });

  app.post('/sellers/reorder', async (request, reply) => {
    const parsed = ReorderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_SELLER_ORDER' });
    }
    if (new Set(parsed.data.sellerIds).size !== parsed.data.sellerIds.length) {
      return reply.code(400).send({ error: 'INVALID_SELLER_ORDER' });
    }

    const existing = await db.selectFrom('sellers').select('id').execute();
    const existingIds = new Set(existing.map((seller) => seller.id));
    if (parsed.data.sellerIds.length !== existing.length || parsed.data.sellerIds.some((id) => !existingIds.has(id))) {
      return reply.code(400).send({ error: 'ORDER_MUST_INCLUDE_EVERY_SELLER' });
    }

    await db.transaction().execute(async (transaction) => {
      await transaction.updateTable('sellers').set({
        rotation_order: sql<number>`rotation_order + 1000000`,
      }).execute();
      for (const [index, sellerId] of parsed.data.sellerIds.entries()) {
        await transaction.updateTable('sellers').set({ rotation_order: index + 1 }).where('id', '=', sellerId).execute();
      }
      await transaction.insertInto('audit_log').values({
        actor_user_id: null,
        action: 'SELLERS_REORDERED',
        entity_type: 'seller',
        entity_id: null,
        before_json: null,
        after_json: JSON.stringify({ sellerIds: parsed.data.sellerIds }),
      }).execute();
    });
    return reply.code(204).send();
  });

  app.put('/sellers/:id', async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    const body = SellerSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_SELLER' });
    const number = normalizeNumber(body.data.whatsappNumber);
    if (!number) return reply.code(400).send({ error: 'INVALID_WHATSAPP_NUMBER' });

    const current = await db.selectFrom('sellers').select(['id', 'active', 'whatsapp_label'])
      .where('id', '=', params.data.id).executeTakeFirst();
    if (!current) return reply.code(404).send({ error: 'SELLER_NOT_FOUND' });
    if (toBoolean(current.active) && !body.data.active) {
      const activeCount = await db.selectFrom('sellers').select((expression) =>
        expression.fn.countAll<number>().as('total'),
      ).where('active', '=', true).executeTakeFirstOrThrow();
      if (Number(activeCount.total) <= 1) return reply.code(409).send({ error: 'LAST_ACTIVE_SELLER' });
    }

    try {
      const whatsappLabel = body.data.whatsappLabel ?? current.whatsapp_label;
      await db.updateTable('sellers').set({
        name: body.data.name,
        whatsapp_number_encrypted: cipher.encrypt(number),
        whatsapp_label: whatsappLabel,
        active: body.data.active,
      }).where('id', '=', current.id).execute();
      await audit(db, 'SELLER_UPDATED', current.id, {
        name: body.data.name,
        whatsappLabel,
        active: body.data.active,
      });
    } catch (error) {
      if (duplicateEntry(error)) return reply.code(409).send({ error: 'SELLER_LABEL_EXISTS' });
      throw error;
    }
    return reply.code(204).send();
  });
}
