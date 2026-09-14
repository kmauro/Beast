import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;

export interface SellersTable {
  id: string;
  name: string;
  whatsapp_number_encrypted: string;
  whatsapp_label: string;
  rotation_order: number;
  active: ColumnType<boolean, boolean | number, boolean | number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ServiceCatalogTable {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: ColumnType<boolean, boolean | number, boolean | number>;
  display_order: number;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface FormTemplatesTable {
  id: string;
  service_id: string;
  name: string;
  description: string | null;
  active: ColumnType<boolean, boolean | number, boolean | number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface FormVersionsTable {
  id: string;
  template_id: string;
  version_number: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  created_by: string | null;
  published_at: NullableTimestamp;
  created_at: Generated<Timestamp>;
}

export interface FormFieldsTable {
  id: string;
  form_version_id: string;
  field_key: string;
  label: string;
  question: string;
  help_text: string | null;
  field_type: 'TEXT' | 'LONG_TEXT' | 'INTEGER' | 'BOOLEAN' | 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE';
  required: ColumnType<boolean, boolean | number, boolean | number>;
  essential: ColumnType<boolean, boolean | number, boolean | number>;
  include_in_summary: ColumnType<boolean, boolean | number, boolean | number>;
  options_json: unknown | null;
  visible_when_json: unknown | null;
  validation_json: unknown | null;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface ConversationsTable {
  id: string;
  whatsapp_chat_id: string;
  customer_number_encrypted: string;
  state: string;
  seller_id: string | null;
  handoff_reason: string | null;
  active_form_version_id: string | null;
  opened_at: Timestamp;
  last_message_at: Timestamp;
  assigned_at: NullableTimestamp;
  closed_at: NullableTimestamp;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface MessagesTable {
  id: string;
  conversation_id: string;
  whatsapp_message_id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  sender_type: 'CUSTOMER' | 'BOT' | 'SELLER' | 'SYSTEM';
  body_encrypted: string;
  occurred_at: Timestamp;
  created_at: Generated<Timestamp>;
}

export interface JobsTable {
  id: string;
  job_type: string;
  deduplication_key: string;
  payload: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  attempts: number;
  max_attempts: number;
  available_at: Timestamp;
  locked_at: NullableTimestamp;
  locked_by: string | null;
  last_error: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface SystemComponentsTable {
  component: string;
  status: 'UP' | 'DEGRADED' | 'DOWN' | 'UNKNOWN';
  detail: string | null;
  metadata: string | null;
  checked_at: Timestamp;
}

export interface AuditLogTable {
  id: Generated<number>;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before_json: unknown | null;
  after_json: unknown | null;
  created_at: Generated<Timestamp>;
}

export interface DatabaseSchema {
  sellers: SellersTable;
  service_catalog: ServiceCatalogTable;
  form_templates: FormTemplatesTable;
  form_versions: FormVersionsTable;
  form_fields: FormFieldsTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  jobs: JobsTable;
  system_components: SystemComponentsTable;
  audit_log: AuditLogTable;
}
