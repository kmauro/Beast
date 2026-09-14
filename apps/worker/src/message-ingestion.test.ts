import type { Message } from 'whatsapp-web.js';
import { describe, expect, it } from 'vitest';
import { resolveWhatsAppMessageIdentity } from './message-ingestion.js';

function messageWith(overrides: Record<string, unknown>): Message {
  return {
    id: {},
    from: '5491112345678@c.us',
    fromMe: false,
    timestamp: 1_789_400_000,
    type: 'chat',
    body: 'Necesito seis cámaras',
    ...overrides,
  } as unknown as Message;
}

describe('resolveWhatsAppMessageIdentity', () => {
  it('prefiere el identificador serializado de WhatsApp', () => {
    const result = resolveWhatsAppMessageIdentity(
      messageWith({ id: { _serialized: 'false_chat_ABC123', id: 'ABC123' } }),
    );

    expect(result).toEqual({ value: 'false_chat_ABC123', source: 'serialized' });
  });

  it('reconstruye el identificador cuando _serialized no está disponible', () => {
    const result = resolveWhatsAppMessageIdentity(
      messageWith({ id: { id: 'ABC123', remote: '5491112345678@c.us', fromMe: false } }),
    );

    expect(result).toEqual({
      value: '0_5491112345678@c.us_ABC123',
      source: 'parts',
    });
  });

  it('produce un fallback determinístico si WhatsApp no entrega ninguna parte del ID', () => {
    const message = messageWith({ id: {} });

    expect(resolveWhatsAppMessageIdentity(message)).toEqual(
      resolveWhatsAppMessageIdentity(message),
    );
    expect(resolveWhatsAppMessageIdentity(message).source).toBe('content-fallback');
  });
});
