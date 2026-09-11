SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  display_name VARCHAR(160) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('ADMIN', 'SELLER') NOT NULL,
  seller_id CHAR(36) NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sellers (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  whatsapp_number_encrypted TEXT NOT NULL,
  whatsapp_label VARCHAR(100) NOT NULL UNIQUE,
  rotation_order INT UNSIGNED NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY sellers_rotation_order_unique (rotation_order)
) ENGINE=InnoDB;

ALTER TABLE users
  ADD CONSTRAINT users_seller_fk
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS service_catalog (
  id CHAR(36) PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  description TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS form_templates (
  id CHAR(36) PRIMARY KEY,
  service_id CHAR(36) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT form_templates_service_fk FOREIGN KEY (service_id) REFERENCES service_catalog(id),
  UNIQUE KEY form_templates_service_name_unique (service_id, name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS form_versions (
  id CHAR(36) PRIMARY KEY,
  template_id CHAR(36) NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  status ENUM('DRAFT', 'PUBLISHED', 'RETIRED') NOT NULL DEFAULT 'DRAFT',
  created_by CHAR(36) NULL,
  published_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT form_versions_template_fk FOREIGN KEY (template_id) REFERENCES form_templates(id),
  CONSTRAINT form_versions_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY form_versions_number_unique (template_id, version_number)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS form_fields (
  id CHAR(36) PRIMARY KEY,
  form_version_id CHAR(36) NOT NULL,
  field_key VARCHAR(100) NOT NULL,
  label VARCHAR(160) NOT NULL,
  question TEXT NOT NULL,
  help_text TEXT NULL,
  field_type ENUM('TEXT', 'LONG_TEXT', 'INTEGER', 'BOOLEAN', 'SINGLE_CHOICE', 'MULTIPLE_CHOICE') NOT NULL,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  essential BOOLEAN NOT NULL DEFAULT FALSE,
  include_in_summary BOOLEAN NOT NULL DEFAULT TRUE,
  options_json JSON NULL,
  visible_when_json JSON NULL,
  validation_json JSON NULL,
  display_order INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT form_fields_version_fk FOREIGN KEY (form_version_id) REFERENCES form_versions(id) ON DELETE CASCADE,
  UNIQUE KEY form_fields_key_unique (form_version_id, field_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS conversations (
  id CHAR(36) PRIMARY KEY,
  whatsapp_chat_id VARCHAR(255) NOT NULL,
  customer_number_encrypted TEXT NOT NULL,
  state VARCHAR(50) NOT NULL,
  seller_id CHAR(36) NULL,
  handoff_reason VARCHAR(50) NULL,
  active_form_version_id CHAR(36) NULL,
  opened_at DATETIME(3) NOT NULL,
  last_message_at DATETIME(3) NOT NULL,
  assigned_at DATETIME(3) NULL,
  closed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT conversations_seller_fk FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE SET NULL,
  CONSTRAINT conversations_form_version_fk FOREIGN KEY (active_form_version_id) REFERENCES form_versions(id) ON DELETE SET NULL,
  KEY conversations_chat_state_idx (whatsapp_chat_id, state),
  KEY conversations_state_activity_idx (state, last_message_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS conversation_services (
  conversation_id CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  primary_service BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (conversation_id, service_id),
  CONSTRAINT conversation_services_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT conversation_services_service_fk FOREIGN KEY (service_id) REFERENCES service_catalog(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS form_answers (
  id CHAR(36) PRIMARY KEY,
  conversation_id CHAR(36) NOT NULL,
  form_field_id CHAR(36) NOT NULL,
  value_json JSON NOT NULL,
  confidence DECIMAL(5,4) NULL,
  source_message_id CHAR(36) NULL,
  confirmed_by_customer BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT form_answers_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT form_answers_field_fk FOREIGN KEY (form_field_id) REFERENCES form_fields(id),
  UNIQUE KEY form_answers_conversation_field_unique (conversation_id, form_field_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS messages (
  id CHAR(36) PRIMARY KEY,
  conversation_id CHAR(36) NOT NULL,
  whatsapp_message_id VARCHAR(255) NOT NULL UNIQUE,
  direction ENUM('INBOUND', 'OUTBOUND') NOT NULL,
  sender_type ENUM('CUSTOMER', 'BOT', 'SELLER', 'SYSTEM') NOT NULL,
  body_encrypted MEDIUMTEXT NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT messages_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  KEY messages_conversation_occurred_idx (conversation_id, occurred_at)
) ENGINE=InnoDB;

ALTER TABLE form_answers
  ADD CONSTRAINT form_answers_source_message_fk
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS summaries (
  id CHAR(36) PRIMARY KEY,
  conversation_id CHAR(36) NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  summary_text TEXT NOT NULL,
  structured_data JSON NOT NULL,
  model_name VARCHAR(160) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT summaries_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  UNIQUE KEY summaries_version_unique (conversation_id, version_number)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS seller_rotation (
  id TINYINT UNSIGNED PRIMARY KEY,
  current_seller_id CHAR(36) NULL,
  assignments_in_batch INT UNSIGNED NOT NULL DEFAULT 0,
  batch_size INT UNSIGNED NOT NULL DEFAULT 5,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT seller_rotation_current_fk FOREIGN KEY (current_seller_id) REFERENCES sellers(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS jobs (
  id CHAR(36) PRIMARY KEY,
  job_type VARCHAR(80) NOT NULL,
  deduplication_key VARCHAR(255) NOT NULL UNIQUE,
  payload JSON NOT NULL,
  status ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 10,
  available_at DATETIME(3) NOT NULL,
  locked_at DATETIME(3) NULL,
  locked_by VARCHAR(160) NULL,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY jobs_poll_idx (status, available_at, locked_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS business_hours (
  weekday TINYINT UNSIGNED PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  opens_at TIME NULL,
  closes_at TIME NULL,
  CONSTRAINT business_hours_weekday_check CHECK (weekday BETWEEN 1 AND 7)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS holidays (
  holiday_date DATE PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS system_components (
  component VARCHAR(80) PRIMARY KEY,
  status ENUM('UP', 'DEGRADED', 'DOWN', 'UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  detail TEXT NULL,
  metadata JSON NULL,
  checked_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bot_settings (
  setting_key VARCHAR(120) PRIMARY KEY,
  setting_value JSON NOT NULL,
  updated_by CHAR(36) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT bot_settings_user_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_user_id CHAR(36) NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(255) NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT audit_log_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  KEY audit_log_entity_idx (entity_type, entity_id, created_at)
) ENGINE=InnoDB;

INSERT IGNORE INTO seller_rotation (id, current_seller_id, assignments_in_batch, batch_size)
VALUES (1, NULL, 0, 5);

INSERT INTO business_hours (weekday, enabled, opens_at, closes_at) VALUES
  (1, TRUE, '09:00:00', '18:00:00'),
  (2, TRUE, '09:00:00', '18:00:00'),
  (3, TRUE, '09:00:00', '18:00:00'),
  (4, TRUE, '09:00:00', '18:00:00'),
  (5, TRUE, '09:00:00', '18:00:00'),
  (6, FALSE, NULL, NULL),
  (7, FALSE, NULL, NULL)
ON DUPLICATE KEY UPDATE
  enabled = VALUES(enabled),
  opens_at = VALUES(opens_at),
  closes_at = VALUES(closes_at);

INSERT IGNORE INTO service_catalog (id, code, name, display_order) VALUES
  (UUID(), 'CAMERAS', 'Instalación de cámaras', 10),
  (UUID(), 'ALARMS', 'Alarmas', 20),
  (UUID(), 'ACCESS_CONTROL', 'Control de acceso', 30),
  (UUID(), 'WIFI_NETWORK', 'Redes Wi-Fi', 40),
  (UUID(), 'WIRED_NETWORK', 'Redes cableadas', 50),
  (UUID(), 'PC_SALES', 'Venta de PCs', 60),
  (UUID(), 'PC_MAINTENANCE', 'Mantenimiento de PCs', 70);

