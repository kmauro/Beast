import type { BeastDatabase, DatabaseSchema } from '@beast/database';
import type { BusinessHourRule, BusinessRules, HolidayItem } from '@beast/shared';
import type { FastifyInstance } from 'fastify';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { ApiConfig } from './config.js';

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const HoursSchema = z.object({
  hours: z.array(z.object({
    weekday: z.number().int().min(1).max(7),
    enabled: z.boolean(),
    opensAt: TimeSchema.nullable(),
    closesAt: TimeSchema.nullable(),
  })).length(7),
}).superRefine((value, context) => {
  if (new Set(value.hours.map((rule) => rule.weekday)).size !== 7) {
    context.addIssue({ code: 'custom', path: ['hours'], message: 'Debe existir una regla por cada día' });
  }
  value.hours.forEach((rule, index) => {
    if (rule.enabled && (!rule.opensAt || !rule.closesAt || rule.opensAt >= rule.closesAt)) {
      context.addIssue({ code: 'custom', path: ['hours', index], message: 'El horario habilitado es inválido' });
    }
  });
});
const HolidaySchema = z.object({ date: DateSchema, name: z.string().trim().min(1).max(255) });
const HolidayParamsSchema = z.object({ date: DateSchema });
const AutomationSchema = z.object({
  followUpAfterBusinessHours: z.number().int().min(1).max(720),
  autoCloseAfterBusinessHours: z.number().int().min(1).max(2160),
}).refine((value) => value.autoCloseAfterBusinessHours > value.followUpAfterBusinessHours, {
  message: 'El cierre automático debe ocurrir después del seguimiento',
  path: ['autoCloseAfterBusinessHours'],
});

function toBoolean(value: boolean | number): boolean {
  return value === true || value === 1;
}

function time(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

function date(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function numericSetting(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    } catch {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

async function writeAudit(
  transaction: Transaction<DatabaseSchema>,
  action: string,
  entityId: string | null,
  after: unknown,
): Promise<void> {
  await transaction.insertInto('audit_log').values({
    actor_user_id: null,
    action,
    entity_type: 'business_rules',
    entity_id: entityId,
    before_json: null,
    after_json: JSON.stringify(after),
  }).execute();
}

export async function registerBusinessRuleRoutes(
  app: FastifyInstance,
  db: BeastDatabase,
  config: ApiConfig,
): Promise<void> {
  app.get('/business-rules', async (): Promise<BusinessRules> => {
    const [hourRows, holidayRows, settingRows] = await Promise.all([
      db.selectFrom('business_hours').selectAll().orderBy('weekday').execute(),
      db.selectFrom('holidays').selectAll().orderBy('holiday_date', 'asc').execute(),
      db.selectFrom('bot_settings').select(['setting_key', 'setting_value'])
        .where('setting_key', 'in', ['follow_up_business_hours', 'auto_close_business_hours']).execute(),
    ]);
    const settings = new Map(settingRows.map((row) => [row.setting_key, row.setting_value]));
    return {
      timezone: config.BUSINESS_TIMEZONE,
      hours: hourRows.map((row): BusinessHourRule => ({
        weekday: row.weekday,
        enabled: toBoolean(row.enabled),
        opensAt: time(row.opens_at),
        closesAt: time(row.closes_at),
      })),
      holidays: holidayRows.map((row): HolidayItem => ({ date: date(row.holiday_date), name: row.name })),
      followUpAfterBusinessHours: numericSetting(
        settings.get('follow_up_business_hours'),
        config.FOLLOW_UP_AFTER_BUSINESS_HOURS,
      ),
      autoCloseAfterBusinessHours: numericSetting(
        settings.get('auto_close_business_hours'),
        config.AUTO_CLOSE_AFTER_BUSINESS_HOURS,
      ),
    };
  });

  app.put('/business-rules/hours', async (request, reply) => {
    const parsed = HoursSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BUSINESS_HOURS', issues: parsed.error.issues });
    await db.transaction().execute(async (transaction) => {
      for (const rule of parsed.data.hours) {
        await transaction.insertInto('business_hours').values({
          weekday: rule.weekday,
          enabled: rule.enabled,
          opens_at: rule.enabled ? rule.opensAt : null,
          closes_at: rule.enabled ? rule.closesAt : null,
        }).onDuplicateKeyUpdate({
          enabled: rule.enabled,
          opens_at: rule.enabled ? rule.opensAt : null,
          closes_at: rule.enabled ? rule.closesAt : null,
        }).execute();
      }
      await writeAudit(transaction, 'BUSINESS_HOURS_UPDATED', null, parsed.data);
    });
    return reply.code(204).send();
  });

  app.post('/business-rules/holidays', async (request, reply) => {
    const parsed = HolidaySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_HOLIDAY', issues: parsed.error.issues });
    await db.transaction().execute(async (transaction) => {
      await transaction.insertInto('holidays').values({
        holiday_date: parsed.data.date,
        name: parsed.data.name,
      }).onDuplicateKeyUpdate({ name: parsed.data.name }).execute();
      await writeAudit(transaction, 'HOLIDAY_SAVED', parsed.data.date, parsed.data);
    });
    return reply.code(204).send();
  });

  app.delete('/business-rules/holidays/:date', async (request, reply) => {
    const parsed = HolidayParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_HOLIDAY_DATE' });
    await db.transaction().execute(async (transaction) => {
      await transaction.deleteFrom('holidays').where('holiday_date', '=', parsed.data.date).execute();
      await writeAudit(transaction, 'HOLIDAY_DELETED', parsed.data.date, null);
    });
    return reply.code(204).send();
  });

  app.put('/business-rules/automation', async (request, reply) => {
    const parsed = AutomationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_AUTOMATION_RULES', issues: parsed.error.issues });
    await db.transaction().execute(async (transaction) => {
      for (const [settingKey, settingValue] of [
        ['follow_up_business_hours', parsed.data.followUpAfterBusinessHours],
        ['auto_close_business_hours', parsed.data.autoCloseAfterBusinessHours],
      ] as const) {
        await transaction.insertInto('bot_settings').values({
          setting_key: settingKey,
          setting_value: JSON.stringify(settingValue),
          updated_by: null,
        }).onDuplicateKeyUpdate({ setting_value: JSON.stringify(settingValue), updated_by: null }).execute();
      }
      await writeAudit(transaction, 'AUTOMATION_RULES_UPDATED', null, parsed.data);
    });
    return reply.code(204).send();
  });
}
