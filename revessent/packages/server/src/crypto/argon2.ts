/**
 * argon2id password hashing (Architecture v1 §7.1) via @noble/hashes —
 * pure JS, no native build step. Params come from env (spec defaults
 * m=65536 KiB / t=3 / p=4; tests lower them for speed, production floor
 * is enforced by packages/config).
 * Format: PHC string $argon2id$v=19$m=..,t=..,p=..$salt_b64$hash_b64
 */
import { argon2id } from "@noble/hashes/argon2.js";
import { randomBytes } from "node:crypto";

export interface Argon2Params {
  memoryKiB: number;
  time: number;
  parallelism: number;
}

export function hashPassword(password: string, params: Argon2Params): string {
  const salt = randomBytes(16);
  const hash = argon2id(password, salt, { m: params.memoryKiB, t: params.time, p: params.parallelism, dkLen: 32 });
  return `$argon2id$v=19$m=${params.memoryKiB},t=${params.time},p=${params.parallelism}$${salt.toString("base64")}$${Buffer.from(hash).toString("base64")}`;
}

export function verifyPassword(password: string, phc: string): boolean {
  const parts = phc.split("$");
  // ["", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash]
  if (parts.length !== 6 || parts[1] !== "argon2id") return false;
  const paramMatch = /m=(\d+),t=(\d+),p=(\d+)/.exec(parts[3] ?? "");
  if (!paramMatch) return false;
  const [, m, t, p] = paramMatch as unknown as [string, string, string, string];
  const params: Argon2Params = { memoryKiB: Number(m), time: Number(t), parallelism: Number(p) };
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  const actual = Buffer.from(argon2id(password, salt, { m: params.memoryKiB, t: params.time, p: params.parallelism, dkLen: expected.length }));
  return actual.length === expected.length && actual.equals(expected);
}
