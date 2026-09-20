import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) throw new Error("Invalid context key.");
  return key;
}
export function sealContext(text: string, key: string, scope: string): string {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", decodeKey(key), nonce);
  cipher.setAAD(Buffer.from(scope));
  const payload = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), payload]).toString("base64");
}
export function openContext(text: string, key: string, scope: string): string {
  const payload = Buffer.from(text, "base64");
  if (payload.length < 28 || payload.toString("base64") !== text) throw new Error("Invalid encrypted context.");
  const cipher = createDecipheriv("aes-256-gcm", decodeKey(key), payload.subarray(0, 12));
  cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([cipher.update(payload.subarray(28)), cipher.final()]).toString("utf8");
}
