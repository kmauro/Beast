import { describe, expect, it } from 'vitest';
import { BotSendTracker } from './job-runner.js';

describe('BotSendTracker', () => {
  it('consume una sola vez el evento emitido por un mensaje del bot', () => {
    const tracker = new BotSendTracker();
    tracker.mark('5491112345678@c.us', 'Mensaje del bot');

    expect(tracker.consume('5491112345678@c.us', 'Mensaje del bot')).toBe(true);
    expect(tracker.consume('5491112345678@c.us', 'Mensaje del bot')).toBe(false);
  });

  it('no confunde mensajes con otro destinatario o contenido', () => {
    const tracker = new BotSendTracker();
    tracker.mark('chat-a', 'Contenido A');

    expect(tracker.consume('chat-b', 'Contenido A')).toBe(false);
    expect(tracker.consume('chat-a', 'Contenido B')).toBe(false);
    expect(tracker.consume('chat-a', 'Contenido A')).toBe(true);
  });
});
