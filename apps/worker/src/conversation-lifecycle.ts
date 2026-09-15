import { enqueueJob, type BeastDatabase } from '@beast/database';
import { assertTransition, ConversationStateSchema, type ConversationState } from '@beast/shared';
import { DateTime } from 'luxon';
import type { WorkerConfig } from './config.js';

interface HourRule {
  weekday: number;
  enabled: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

export interface BusinessCalendarRules {
  timezone: string;
  hours: Map<number, HourRule>;
  holidays: Set<string>;
  followUpHours: number;
  autoCloseHours: number;
}

function toBoolean(value: boolean | number): boolean {
  return value === true || value === 1;
}

function settingNumber(value: unknown, fallback: number): number {
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

function dateKey(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function atLocalTime(day: DateTime, value: string): DateTime {
  const [hour = 0, minute = 0] = value.slice(0, 5).split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

export function isBusinessOpen(at: Date, rules: BusinessCalendarRules): boolean {
  const local = DateTime.fromJSDate(at, { zone: 'utc' }).setZone(rules.timezone);
  if (!local.isValid || rules.holidays.has(local.toISODate() ?? '')) return false;
  const rule = rules.hours.get(local.weekday);
  if (!rule?.enabled || !rule.opensAt || !rule.closesAt) return false;
  const opens = atLocalTime(local.startOf('day'), rule.opensAt);
  const closes = atLocalTime(local.startOf('day'), rule.closesAt);
  return local.toMillis() >= opens.toMillis() && local.toMillis() < closes.toMillis();
}

export function businessHoursBetween(
  start: Date,
  end: Date,
  rules: BusinessCalendarRules,
  stopAfterHours = Number.POSITIVE_INFINITY,
): number {
  if (end.getTime() <= start.getTime()) return 0;
  const localStart = DateTime.fromJSDate(start, { zone: 'utc' }).setZone(rules.timezone);
  const localEnd = DateTime.fromJSDate(end, { zone: 'utc' }).setZone(rules.timezone);
  if (!localStart.isValid || !localEnd.isValid) return 0;

  let day = localStart.startOf('day');
  let total = 0;
  let inspectedDays = 0;
  while (day.toMillis() <= localEnd.toMillis() && inspectedDays < 3660) {
    const localDate = day.toISODate() ?? '';
    const rule = rules.hours.get(day.weekday);
    if (!rules.holidays.has(localDate) && rule?.enabled && rule.opensAt && rule.closesAt) {
      const opens = atLocalTime(day, rule.opensAt);
      const closes = atLocalTime(day, rule.closesAt);
      const overlapStart = Math.max(opens.toMillis(), localStart.toMillis());
      const overlapEnd = Math.min(closes.toMillis(), localEnd.toMillis());
      if (overlapEnd > overlapStart) total += (overlapEnd - overlapStart) / 3_600_000;
      if (total >= stopAfterHours) return total;
    }
    day = day.plus({ days: 1 });
    inspectedDays += 1;
  }
  return total;
}

export class ConversationLifecycle {
  private cachedRules: BusinessCalendarRules | null = null;
  private cacheExpiresAt = 0;

  constructor(private readonly db: BeastDatabase, private readonly config: WorkerConfig) {}

  private async rules(): Promise<BusinessCalendarRules> {
    if (this.cachedRules && Date.now() < this.cacheExpiresAt) return this.cachedRules;
    const [hours, holidays, settings] = await Promise.all([
      this.db.selectFrom('business_hours').selectAll().execute(),
      this.db.selectFrom('holidays').select(['holiday_date']).execute(),
      this.db.selectFrom('bot_settings').select(['setting_key', 'setting_value'])
        .where('setting_key', 'in', ['follow_up_business_hours', 'auto_close_business_hours']).execute(),
    ]);
    const settingMap = new Map(settings.map((setting) => [setting.setting_key, setting.setting_value]));
    this.cachedRules = {
      timezone: this.config.BUSINESS_TIMEZONE,
      hours: new Map(hours.map((rule) => [rule.weekday, {
        weekday: rule.weekday,
        enabled: toBoolean(rule.enabled),
        opensAt: rule.opens_at?.slice(0, 5) ?? null,
        closesAt: rule.closes_at?.slice(0, 5) ?? null,
      }] as const)),
      holidays: new Set(holidays.map((holiday) => dateKey(holiday.holiday_date))),
      followUpHours: settingNumber(
        settingMap.get('follow_up_business_hours'),
        this.config.FOLLOW_UP_AFTER_BUSINESS_HOURS,
      ),
      autoCloseHours: settingNumber(
        settingMap.get('auto_close_business_hours'),
        this.config.AUTO_CLOSE_AFTER_BUSINESS_HOURS,
      ),
    };
    this.cacheExpiresAt = Date.now() + 60_000;
    return this.cachedRules;
  }

  async handleInbound(conversationId: string, occurredAt: Date): Promise<void> {
    const conversation = await this.db.selectFrom('conversations')
      .select(['state']).where('id', '=', conversationId).executeTakeFirst();
    if (!conversation) return;
    const from = ConversationStateSchema.parse(conversation.state);
    const open = isBusinessOpen(occurredAt, await this.rules());
    let to: ConversationState | null = null;
    if (from === 'NEW') to = open ? 'BOT_QUALIFYING' : 'OUT_OF_HOURS';
    else if (from === 'OUT_OF_HOURS' && open) to = 'BOT_QUALIFYING';
    else if (from === 'BOT_QUALIFYING' && !open) to = 'OUT_OF_HOURS';
    else if (from === 'PENDING_FOLLOW_UP') to = 'SELLER_ASSIGNED';
    if (!to || to === from) return;
    await this.transition(conversationId, from, to, 'INBOUND_MESSAGE');
  }

  async handleSellerActivity(conversationId: string): Promise<void> {
    const conversation = await this.db.selectFrom('conversations')
      .select(['state']).where('id', '=', conversationId).executeTakeFirst();
    if (!conversation) return;
    const from = ConversationStateSchema.parse(conversation.state);
    if (from === 'PENDING_FOLLOW_UP') {
      await this.transition(conversationId, from, 'SELLER_ASSIGNED', 'SELLER_MESSAGE');
    }
  }

  async sweep(now = new Date()): Promise<{ resumed: number; followedUp: number; closed: number }> {
    const rules = await this.rules();
    const conversations = await this.db.selectFrom('conversations')
      .select(['id', 'state', 'last_message_at', 'assigned_at'])
      .where('state', 'in', ['NEW', 'OUT_OF_HOURS', 'SELLER_ASSIGNED', 'PENDING_FOLLOW_UP'])
      .orderBy('last_message_at', 'asc')
      .limit(1000)
      .execute();
    let resumed = 0;
    let followedUp = 0;
    let closed = 0;
    for (const conversation of conversations) {
      const from = ConversationStateSchema.parse(conversation.state);
      if (from === 'NEW') {
        const target = isBusinessOpen(now, rules) ? 'BOT_QUALIFYING' : 'OUT_OF_HOURS';
        if (await this.transition(conversation.id, from, target, 'LIFECYCLE_SWEEP')) resumed += 1;
        continue;
      }
      if (from === 'OUT_OF_HOURS') {
        if (isBusinessOpen(now, rules) &&
          await this.transition(conversation.id, from, 'BOT_QUALIFYING', 'BUSINESS_REOPENED')) {
          resumed += 1;
        }
        continue;
      }
      const lastMessageAt = new Date(conversation.last_message_at);
      const assignedAt = conversation.assigned_at ? new Date(conversation.assigned_at) : null;
      const inactivityStartedAt =
        assignedAt && assignedAt.getTime() > lastMessageAt.getTime() ? assignedAt : lastMessageAt;
      const elapsed = businessHoursBetween(
        inactivityStartedAt,
        now,
        rules,
        rules.autoCloseHours,
      );
      if (elapsed >= rules.autoCloseHours) {
        if (await this.transition(
          conversation.id,
          from,
          'CLOSED',
          'AUTO_CLOSE',
          lastMessageAt,
        )) closed += 1;
      } else if (from === 'SELLER_ASSIGNED' && elapsed >= rules.followUpHours) {
        if (await this.transition(
          conversation.id,
          from,
          'PENDING_FOLLOW_UP',
          'FOLLOW_UP_DUE',
          lastMessageAt,
        )) followedUp += 1;
      }
    }
    return { resumed, followedUp, closed };
  }

  private async transition(
    conversationId: string,
    from: ConversationState,
    to: ConversationState,
    reason: string,
    expectedLastMessageAt: Date | null = null,
  ): Promise<boolean> {
    assertTransition(from, to);
    const transitionedAt = new Date();
    return this.db.transaction().execute(async (transaction) => {
      let update = transaction.updateTable('conversations').set({
        state: to,
        closed_at: to === 'CLOSED' ? transitionedAt : null,
      }).where('id', '=', conversationId).where('state', '=', from);
      if (expectedLastMessageAt) {
        update = update.where('last_message_at', '=', expectedLastMessageAt);
      }
      const result = await update.executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return false;
      await transaction.insertInto('audit_log').values({
        actor_user_id: null,
        action: 'CONVERSATION_STATE_CHANGED',
        entity_type: 'conversation',
        entity_id: conversationId,
        before_json: JSON.stringify({ state: from }),
        after_json: JSON.stringify({ state: to, reason }),
      }).execute();
      await enqueueJob(transaction, {
        jobType: 'APPLY_CONVERSATION_LABEL',
        deduplicationKey: `state-label:${conversationId}:${to}:${transitionedAt.toISOString()}`,
        payload: { conversationId, force: reason === 'INBOUND_MESSAGE' },
        maxAttempts: 10,
      });
      return true;
    });
  }
}
