import type { ConversationState } from './conversation.js';
import type { FormFieldDefinition } from './forms.js';

export interface ConversationListItem {
  id: string;
  customer: string;
  state: ConversationState;
  sellerName: string | null;
  messageCount: number;
  openedAt: string;
  lastMessageAt: string;
}

export interface ConversationListResponse {
  items: ConversationListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ConversationMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  senderType: 'CUSTOMER' | 'BOT' | 'SELLER' | 'SYSTEM';
  body: string;
  occurredAt: string;
}

export interface ConversationDetail extends ConversationListItem {
  messages: ConversationMessage[];
}

export interface SellerItem {
  id: string;
  name: string;
  whatsappNumber: string;
  whatsappLabel: string;
  rotationOrder: number;
  active: boolean;
}

export interface BusinessHourRule {
  weekday: number;
  enabled: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

export interface HolidayItem {
  date: string;
  name: string;
}

export interface BusinessRules {
  timezone: string;
  hours: BusinessHourRule[];
  holidays: HolidayItem[];
  followUpAfterBusinessHours: number;
  autoCloseAfterBusinessHours: number;
}

export interface FormTemplateSummary {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  draftVersion: number | null;
  publishedVersion: number | null;
}

export interface ServiceForms {
  id: string;
  code: string;
  name: string;
  description: string | null;
  templates: FormTemplateSummary[];
}

export interface FormVersionDetail {
  id: string;
  versionNumber: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  fields: FormFieldDefinition[];
}

export interface FormDetail extends FormTemplateSummary {
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  version: FormVersionDetail;
}
