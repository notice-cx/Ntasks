/**
 * The format of a service credential's bearer token:
 * `ntasks_service.<credential id>.<secret>`. The prefix lets the verifier tell
 * it from an OAuth access token and lets secret scanners find a leaked one.
 * The id finds the stored credential; only the secret's SHA-256 is stored.
 */

export const SERVICE_TOKEN_PREFIX = 'ntasks_service';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOKEN = new RegExp(`^${SERVICE_TOKEN_PREFIX}\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`, 'u');

export function serviceToken(id: string, secret: string): string {
  return `${SERVICE_TOKEN_PREFIX}.${id}.${secret}`;
}

export function parseServiceToken(token: string): { readonly id: string; readonly secret: string } | null {
  const match = TOKEN.exec(token);
  return match?.[1] && match[2] ? { id: match[1], secret: match[2] } : null;
}
