import { describe, expect, it } from 'vitest';
import {
  businessHoursBetween,
  isBusinessOpen,
  type BusinessCalendarRules,
} from './conversation-lifecycle.js';

function rules(holidays: string[] = []): BusinessCalendarRules {
  return {
    timezone: 'America/Argentina/Buenos_Aires',
    hours: new Map([1, 2, 3, 4, 5].map((weekday) => [weekday, {
      weekday,
      enabled: true,
      opensAt: '09:00',
      closesAt: '18:00',
    }] as const)),
    holidays: new Set(holidays),
    followUpHours: 24,
    autoCloseHours: 72,
  };
}

describe('calendario comercial', () => {
  it('reconoce el horario en Buenos Aires y excluye el cierre', () => {
    expect(isBusinessOpen(new Date('2026-09-14T12:00:00Z'), rules())).toBe(true);
    expect(isBusinessOpen(new Date('2026-09-14T21:00:00Z'), rules())).toBe(false);
  });

  it('excluye fines de semana y feriados', () => {
    expect(isBusinessOpen(new Date('2026-09-19T15:00:00Z'), rules())).toBe(false);
    expect(isBusinessOpen(new Date('2026-09-14T15:00:00Z'), rules(['2026-09-14']))).toBe(false);
  });

  it('cuenta horas hábiles atravesando un fin de semana', () => {
    const elapsed = businessHoursBetween(
      new Date('2026-09-18T12:00:00Z'),
      new Date('2026-09-21T21:00:00Z'),
      rules(),
    );
    expect(elapsed).toBe(18);
  });
});
