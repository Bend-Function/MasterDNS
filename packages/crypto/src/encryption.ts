import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

export type EncryptedValue = {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
};

export function parseEncryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw new Error("MASTER_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function encryptJson(value: unknown, key: Buffer, keyVersion = 1): EncryptedValue {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion,
  };
}

export function decryptJson<T>(value: EncryptedValue, key: Buffer): T {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
