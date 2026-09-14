import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  PANEL_ADMIN_USERNAME: z.string().min(1).max(80).default('admin'),
  PANEL_ADMIN_PASSWORD: z.string().min(12),
  PANEL_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  DATA_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine((value) => {
      const decoded = Buffer.from(value, 'base64');
      return decoded.length === 32 && decoded.toString('base64') === value;
    }, 'Debe ser una clave Base64 válida de 32 bytes'),
  OLLAMA_BASE_URL: z.string().url().default('http://host.docker.internal:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3:4b'),
});

export type ApiConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  return ConfigSchema.parse(environment);
}
