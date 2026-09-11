import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const WorkerConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  OLLAMA_BASE_URL: z.string().url().default('http://host.docker.internal:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3:4b'),
  WHATSAPP_CLIENT_ID: z.string().min(1).default('beast-main'),
  WHATSAPP_AUTH_PATH: z.string().min(1).default('/app/data/whatsapp-auth'),
  WHATSAPP_HEADLESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  BOT_REPLY_ENABLED: booleanFromString,
  BUSINESS_TIMEZONE: z.string().default('America/Argentina/Buenos_Aires'),
  SELLER_BATCH_SIZE: z.coerce.number().int().positive().default(5),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return WorkerConfigSchema.parse(environment);
}

