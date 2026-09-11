import { z } from 'zod';

export const ComponentHealthSchema = z.object({
  component: z.string(),
  status: z.enum(['UP', 'DEGRADED', 'DOWN', 'UNKNOWN']),
  checkedAt: z.string().datetime(),
  detail: z.string().nullable(),
});

export const SystemHealthSchema = z.object({
  status: z.enum(['UP', 'DEGRADED', 'DOWN']),
  checkedAt: z.string().datetime(),
  components: z.array(ComponentHealthSchema),
});

export type ComponentHealth = z.infer<typeof ComponentHealthSchema>;
export type SystemHealth = z.infer<typeof SystemHealthSchema>;

