import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const WorkerConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATA_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine((value) => {
      const decoded = Buffer.from(value, 'base64');
      return decoded.length === 32 && decoded.toString('base64') === value;
    }, 'Debe ser una clave Base64 válida de 32 bytes'),
  OLLAMA_BASE_URL: z.string().url().default('http://host.docker.internal:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3:4b'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(180_000),
  MODEL_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.62),
  MODEL_MIN_FIELD_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.55),
  MODEL_CONTEXT_MESSAGES: z.coerce.number().int().min(5).max(100).default(30),
  MODEL_CONTEXT_MAX_CHARS: z.coerce.number().int().min(2_000).max(100_000).default(16_000),
  WHATSAPP_CLIENT_ID: z.string().min(1).default('beast-main'),
  WHATSAPP_AUTH_PATH: z.string().min(1).default('/app/data/whatsapp-auth'),
  WHATSAPP_HEADLESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  BOT_REPLY_ENABLED: booleanFromString,
  BUSINESS_TIMEZONE: z.string().default('America/Argentina/Buenos_Aires'),
  SELLER_BATCH_SIZE: z.coerce.number().int().positive().default(5),
  FOLLOW_UP_AFTER_BUSINESS_HOURS: z.coerce.number().int().positive().default(24),
  AUTO_CLOSE_AFTER_BUSINESS_HOURS: z.coerce.number().int().positive().default(72),
  LIFECYCLE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(15_000).default(60_000),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  JOB_STALE_AFTER_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  ANALYSIS_DEBOUNCE_MS: z.coerce.number().int().min(0).max(60_000).default(3_000),
  BOT_REPLY_COOLDOWN_MS: z.coerce.number().int().min(1_000).max(300_000).default(5_000),
  OUTBOUND_MIN_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_500),
  LABEL_SYNC_INTERVAL_MS: z.coerce.number().int().min(15_000).max(3_600_000).default(60_000),
  LABEL_NEW: z.string().min(1).default('NUEVO'),
  LABEL_BOT: z.string().min(1).default('BOT'),
  LABEL_CLOSED: z.string().min(1).default('CERRADO'),
  LABEL_OUT_OF_HOURS: z.string().min(1).default('FUERA_DE_HORARIO'),
}).refine(
  (value) => value.AUTO_CLOSE_AFTER_BUSINESS_HOURS > value.FOLLOW_UP_AFTER_BUSINESS_HOURS,
  {
    message: 'AUTO_CLOSE_AFTER_BUSINESS_HOURS debe ser mayor que FOLLOW_UP_AFTER_BUSINESS_HOURS',
    path: ['AUTO_CLOSE_AFTER_BUSINESS_HOURS'],
  },
);

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return WorkerConfigSchema.parse(environment);
}
