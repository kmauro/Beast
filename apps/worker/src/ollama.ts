import { z } from 'zod';
import type { WorkerConfig } from './config.js';

const AnswerValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

export const QualificationAnalysisSchema = z.object({
  serviceCode: z.string().nullable(),
  serviceConfidence: z.number().min(0).max(1),
  answers: z.array(z.object({
    fieldKey: z.string(),
    value: AnswerValueSchema,
    confidence: z.number().min(0).max(1),
    confirmed: z.boolean(),
  })),
  missingFieldKeys: z.array(z.string()),
  overallConfidence: z.number().min(0).max(1),
  humanRequested: z.boolean(),
  needsHuman: z.boolean(),
  readyForHandoff: z.boolean(),
  reply: z.string().max(1200),
  summary: z.string().max(3000),
});

export type QualificationAnalysis = z.infer<typeof QualificationAnalysisSchema>;

const responseSchema = z.object({
  message: z.object({ content: z.string() }),
});

const outputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    serviceCode: { type: ['string', 'null'] },
    serviceConfidence: { type: 'number', minimum: 0, maximum: 1 },
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fieldKey: { type: 'string' },
          value: {
            oneOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'array', items: { type: 'string' } },
              { type: 'null' },
            ],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          confirmed: { type: 'boolean' },
        },
        required: ['fieldKey', 'value', 'confidence', 'confirmed'],
      },
    },
    missingFieldKeys: { type: 'array', items: { type: 'string' } },
    overallConfidence: { type: 'number', minimum: 0, maximum: 1 },
    humanRequested: { type: 'boolean' },
    needsHuman: { type: 'boolean' },
    readyForHandoff: { type: 'boolean' },
    reply: { type: 'string' },
    summary: { type: 'string' },
  },
  required: [
    'serviceCode',
    'serviceConfidence',
    'answers',
    'missingFieldKeys',
    'overallConfidence',
    'humanRequested',
    'needsHuman',
    'readyForHandoff',
    'reply',
    'summary',
  ],
} as const;

export interface QualificationPromptInput {
  state: string;
  services: Array<{
    code: string;
    name: string;
    fields: Array<{
      key: string;
      question: string;
      type: string;
      required: boolean;
      essential: boolean;
      options: string[];
    }>;
  }>;
  existingAnswers: Record<string, unknown>;
  messages: Array<{ role: 'customer' | 'business'; content: string }>;
}

export class OllamaClient {
  constructor(private readonly config: WorkerConfig) {}

  async analyze(input: QualificationPromptInput): Promise<QualificationAnalysis> {
    const constrainedSchema = {
      ...outputJsonSchema,
      properties: {
        ...outputJsonSchema.properties,
        serviceCode: {
          oneOf: [
            { type: 'string', enum: input.services.map((service) => service.code) },
            { type: 'null' },
          ],
        },
      },
    } as const;
    const schemaText = JSON.stringify(constrainedSchema);
    const system = [
      'Sos el clasificador de consultas de una empresa de seguridad, redes y computación.',
      'Respondé únicamente con JSON válido que cumpla exactamente el esquema provisto.',
      'No inventes datos. Extraé respuestas sólo cuando el cliente las haya expresado.',
      'serviceCode debe ser uno de los códigos disponibles o null.',
      'Marcá humanRequested si el cliente pide hablar con una persona.',
      'Marcá needsHuman ante ambigüedad, conflicto, reclamo, urgencia sensible o duda real.',
      'Usá español rioplatense, tono breve y profesional en reply y summary.',
      `Esquema JSON: ${schemaText}`,
    ].join('\n');
    const response = await fetch(`${this.config.OLLAMA_BASE_URL.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.config.OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.config.OLLAMA_MODEL,
        stream: false,
        format: constrainedSchema,
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(input) },
        ],
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Ollama respondió ${response.status}: ${detail.slice(0, 500)}`);
    }
    const envelope = responseSchema.parse(await response.json());
    let parsed: unknown;
    try {
      parsed = JSON.parse(envelope.message.content) as unknown;
    } catch {
      throw new Error('Ollama devolvió contenido que no es JSON válido');
    }
    return QualificationAnalysisSchema.parse(parsed);
  }
}
