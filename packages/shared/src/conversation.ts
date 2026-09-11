import { z } from 'zod';

export const conversationStates = [
  'NEW',
  'BOT_QUALIFYING',
  'OUT_OF_HOURS',
  'READY_FOR_HANDOFF',
  'SELLER_ASSIGNED',
  'PENDING_FOLLOW_UP',
  'CLOSED',
] as const;

export const ConversationStateSchema = z.enum(conversationStates);
export type ConversationState = z.infer<typeof ConversationStateSchema>;

export const serviceCodes = [
  'CAMERAS',
  'ALARMS',
  'ACCESS_CONTROL',
  'WIFI_NETWORK',
  'WIRED_NETWORK',
  'PC_SALES',
  'PC_MAINTENANCE',
] as const;

export const ServiceCodeSchema = z.enum(serviceCodes);
export type ServiceCode = z.infer<typeof ServiceCodeSchema>;

export const handoffReasons = [
  'QUALIFICATION_COMPLETE',
  'HUMAN_REQUESTED',
  'MODEL_UNCERTAIN',
] as const;

export const HandoffReasonSchema = z.enum(handoffReasons);
export type HandoffReason = z.infer<typeof HandoffReasonSchema>;

