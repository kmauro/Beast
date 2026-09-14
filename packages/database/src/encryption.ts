import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = 'v1';

export function decodeEncryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64');

  if (key.length !== KEY_BYTES || key.toString('base64') !== encodedKey) {
    throw new Error('DATA_ENCRYPTION_KEY debe ser una clave Base64 válida de 32 bytes');
  }

  return key;
}

export class SensitiveDataCipher {
  readonly #key: Buffer;

  constructor(encodedKey: string) {
    this.#key = decodeEncryptionKey(encodedKey);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();

    return [VERSION, iv, authenticationTag, ciphertext]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
      .join(':');
  }

  lookupHash(value: string): string {
    return createHmac('sha256', this.#key).update(value, 'utf8').digest('hex');
  }

  decrypt(payload: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext, ...extraParts] = payload.split(':');

    if (
      version !== VERSION ||
      !encodedIv ||
      !encodedTag ||
      !encodedCiphertext ||
      extraParts.length > 0
    ) {
      throw new Error('Formato de dato cifrado inválido');
    }

    const iv = Buffer.from(encodedIv, 'base64');
    const authenticationTag = Buffer.from(encodedTag, 'base64');
    const ciphertext = Buffer.from(encodedCiphertext, 'base64');

    if (iv.length !== IV_BYTES || authenticationTag.length !== 16) {
      throw new Error('Parámetros de dato cifrado inválidos');
    }

    const decipher = createDecipheriv(ALGORITHM, this.#key, iv);
    decipher.setAuthTag(authenticationTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
