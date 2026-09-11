import type { ConversationState } from './conversation.js';

const transitions: Record<ConversationState, ReadonlySet<ConversationState>> = {
  NEW: new Set(['BOT_QUALIFYING', 'OUT_OF_HOURS', 'SELLER_ASSIGNED', 'CLOSED']),
  BOT_QUALIFYING: new Set(['OUT_OF_HOURS', 'READY_FOR_HANDOFF', 'SELLER_ASSIGNED', 'CLOSED']),
  OUT_OF_HOURS: new Set(['BOT_QUALIFYING', 'READY_FOR_HANDOFF', 'SELLER_ASSIGNED', 'CLOSED']),
  READY_FOR_HANDOFF: new Set(['SELLER_ASSIGNED', 'CLOSED']),
  SELLER_ASSIGNED: new Set(['PENDING_FOLLOW_UP', 'CLOSED']),
  PENDING_FOLLOW_UP: new Set(['SELLER_ASSIGNED', 'CLOSED']),
  CLOSED: new Set(['NEW']),
};

export function canTransition(from: ConversationState, to: ConversationState): boolean {
  return transitions[from].has(to);
}

export function assertTransition(from: ConversationState, to: ConversationState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Transición de conversación inválida: ${from} -> ${to}`);
  }
}

