import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SensitiveDataCipher, decodeEncryptionKey } from './encryption.js';

describe('SensitiveDataCipher', () => {
  it('cifra y descifra texto sin almacenarlo en claro', () => {
    const cipher = new SensitiveDataCipher(randomBytes(32).toString('base64'));
    const plaintext = 'Cliente interesado en seis cámaras';
    const encrypted = cipher.encrypt(plaintext);

    expect(encrypted).not.toContain(plaintext);
    expect(cipher.decrypt(encrypted)).toBe(plaintext);
  });

  it('usa un IV diferente para cada cifrado', () => {
    const cipher = new SensitiveDataCipher(randomBytes(32).toString('base64'));

    expect(cipher.encrypt('mismo texto')).not.toBe(cipher.encrypt('mismo texto'));
  });

  it('genera hashes estables para búsquedas sin revelar el identificador', () => {
    const cipher = new SensitiveDataCipher(randomBytes(32).toString('base64'));
    const identifier = '5491112345678@c.us';

    expect(cipher.lookupHash(identifier)).toBe(cipher.lookupHash(identifier));
    expect(cipher.lookupHash(identifier)).not.toContain(identifier);
    expect(cipher.lookupHash('5491187654321@c.us')).not.toBe(cipher.lookupHash(identifier));
  });

  it('rechaza claves que no tengan 32 bytes', () => {
    expect(() => decodeEncryptionKey(Buffer.from('corta').toString('base64'))).toThrow(
      'DATA_ENCRYPTION_KEY',
    );
  });
});
