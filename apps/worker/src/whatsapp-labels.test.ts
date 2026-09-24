import { describe, expect, it, vi } from 'vitest';
import type { BeastDatabase, SensitiveDataCipher } from '@beast/database';
import type whatsapp from 'whatsapp-web.js';
import type { WorkerConfig } from './config.js';
import { WhatsAppLabelManager } from './whatsapp-labels.js';

function queryReturning<T>(value: T) {
  const query = {
    leftJoin: () => query,
    select: () => query,
    where: () => query,
    executeTakeFirst: async () => value,
    execute: async () => value,
  };
  return query;
}

describe('WhatsAppLabelManager', () => {
  it('lee las etiquetas desde el chat cacheado y evita getChatLabels para identificadores @lid', async () => {
    const conversation = {
      id: 'conversation-id',
      state: 'SELLER_ASSIGNED',
      customer_number_encrypted: 'encrypted-chat',
      seller_label: 'VENDEDOR_2',
    };
    const sellers = [{ whatsapp_label: 'VENDEDOR_2' }];
    const auditInsert = { values: () => ({ execute: async () => undefined }) };
    const db = {
      selectFrom: (table: string) => table === 'conversations as conversation'
        ? queryReturning(conversation)
        : queryReturning(sellers),
      insertInto: () => auditInsert,
    } as unknown as BeastDatabase;
    const addOrRemoveLabels = vi.fn(async () => undefined);
    const getChatLabels = vi.fn(async () => {
      throw new Error('No debería llamarse');
    });
    const client = {
      pupPage: { evaluate: vi.fn(async () => ['unmanaged', 'bot']) },
      getLabels: vi.fn(async () => [
        { id: 'unmanaged', name: 'IMPORTANTE' },
        { id: 'bot', name: 'BOT' },
        { id: 'seller', name: 'VENDEDOR_2' },
      ]),
      getChatLabels,
      addOrRemoveLabels,
    } as unknown as whatsapp.Client;
    const cipher = { decrypt: () => '123456789@lid' } as unknown as SensitiveDataCipher;
    const config = {
      LABEL_NEW: 'NUEVO',
      LABEL_BOT: 'BOT',
      LABEL_OUT_OF_HOURS: 'FUERA_DE_HORARIO',
      LABEL_CLOSED: 'CERRADO',
    } as WorkerConfig;

    const manager = new WhatsAppLabelManager(client, db, cipher, config);
    await manager.applyConversationLabel('conversation-id');

    expect(getChatLabels).not.toHaveBeenCalled();
    expect(addOrRemoveLabels).toHaveBeenCalledWith(
      ['unmanaged', 'seller'],
      ['123456789@lid'],
    );
  });
});
