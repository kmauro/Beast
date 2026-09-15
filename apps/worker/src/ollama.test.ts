import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerConfig } from './config.js';
import { OllamaClient } from './ollama.js';

const config = {
  OLLAMA_BASE_URL: 'http://ollama.test:11434',
  OLLAMA_MODEL: 'test-model',
  OLLAMA_TIMEOUT_MS: 10_000,
} as WorkerConfig;

const input = {
  state: 'BOT_QUALIFYING',
  services: [{ code: 'CAMERAS', name: 'Cámaras', fields: [] }],
  existingAnswers: {},
  messages: [{ role: 'customer' as const, content: 'Necesito cámaras' }],
};

afterEach(() => vi.unstubAllGlobals());

describe('OllamaClient', () => {
  it('solicita una salida estructurada sin streaming y valida la respuesta', async () => {
    const content = {
      serviceCode: 'CAMERAS',
      serviceConfidence: 0.92,
      answers: [],
      missingFieldKeys: ['customer_name'],
      overallConfidence: 0.8,
      humanRequested: false,
      needsHuman: false,
      readyForHandoff: false,
      reply: '¿Cuál es tu nombre?',
      summary: 'Consulta por cámaras.',
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: { content: JSON.stringify(content) },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new OllamaClient(config).analyze(input)).resolves.toEqual(content);
    const request = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      stream: boolean;
      format: { properties: { serviceCode: { oneOf: Array<{ enum?: string[] }> } } };
      options: { temperature: number };
    };
    expect(request.stream).toBe(false);
    expect(request.format).toBeTypeOf('object');
    expect(request.format.properties.serviceCode.oneOf[0]?.enum).toEqual(['CAMERAS']);
    expect(request.options.temperature).toBe(0);
  });

  it('rechaza contenido que no cumple el esquema aunque Ollama responda 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: { content: '{"serviceCode":"CAMERAS"}' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    await expect(new OllamaClient(config).analyze(input)).rejects.toThrow();
  });
});
