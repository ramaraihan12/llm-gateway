import { createHash, randomBytes } from 'node:crypto';

export function generateKey(): string {
  return `gw-${randomBytes(32).toString('base64url')}`;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
