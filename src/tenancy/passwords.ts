import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;

export const MIN_PASSWORD_LENGTH = 10;

/** scrypt$N$r$p$salt$hash — self-describing so parameters can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  // Always do the work, so an unknown email and a wrong password take the same time.
  const parts = (stored ?? '').split('$');
  const valid = parts.length === 6 && parts[0] === 'scrypt';
  const salt = valid ? Buffer.from(parts[4], 'base64url') : randomBytes(16);
  const expected = valid ? Buffer.from(parts[5], 'base64url') : randomBytes(KEY_LENGTH);
  const params = valid ? { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) } : PARAMS;
  const key = await scrypt(password, salt, expected.length, params);
  return valid && key.length === expected.length && timingSafeEqual(key, expected);
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`;
  if (password.length > 200) return 'That password is too long.';
  return null;
}
