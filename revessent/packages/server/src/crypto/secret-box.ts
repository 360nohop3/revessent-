/**
 * AES-256-GCM envelope encryption for Stripe restricted keys / webhook
 * secrets (Architecture v1 §7.5). Master key from KEY_ENCRYPTION_KEY env —
 * never stored in the DB, rotatable via re-encrypt job (Phase 7).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

function masterKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("KEY_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

export function sealSecret(plaintext: string, base64Key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey(base64Key), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function openSecret(sealed: string, base64Key: string): string {
  const [ivB64, tagB64, dataB64] = sealed.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("malformed sealed secret");
  const decipher = createDecipheriv(ALGO, masterKey(base64Key), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** Only the shape/last4 is ever returned to clients — never the key itself. */
export function keyDisplayLast4(restrictedKey: string): string {
  return restrictedKey.slice(-4);
}
