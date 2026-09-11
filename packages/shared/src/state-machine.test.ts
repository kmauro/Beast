import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition } from './state-machine.js';

describe('conversation state machine', () => {
  it('permite reabrir una conversación cerrada como nueva', () => {
    expect(canTransition('CLOSED', 'NEW')).toBe(true);
  });

  it('impide que el bot recupere directamente una conversación del vendedor', () => {
    expect(canTransition('SELLER_ASSIGNED', 'BOT_QUALIFYING')).toBe(false);
  });

  it('permite señalar seguimiento pendiente antes del cierre', () => {
    expect(canTransition('SELLER_ASSIGNED', 'PENDING_FOLLOW_UP')).toBe(true);
  });

  it('lanza un error ante una transición inválida', () => {
    expect(() => assertTransition('CLOSED', 'SELLER_ASSIGNED')).toThrow(
      'Transición de conversación inválida',
    );
  });
});

