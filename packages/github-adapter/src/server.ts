/**
 * The adapter's HTTP server: POST /mcp, signed in by a bearer token the
 * configuration names by its SHA-256. A request with no token, or one the
 * configuration does not name, gets 401 and nothing else.
 */
import { createServer, type Server } from 'node:http';
import type { AdapterConfig } from './config.ts';
import { tokenHash } from './config.ts';
import { Engine, type Sender } from './engine.ts';
import { GitHub } from './github.ts';
import { Ledger } from './ledger.ts';
import { answer } from './mcp.ts';

export const MCP_PATH = '/mcp';
const BODY_BYTES = 256 * 1024;

/** The sender each configured token signs in, by its SHA-256. */
function senders(config: AdapterConfig): Map<string, Sender> {
  return new Map(
    config.senders.map((sender) => {
      const prefixed = /^(agent|service|visitor|person):/u.test(sender.name);
      const actor =
        sender.kind === 'agent'
          ? `agent:${sender.name}`
          : sender.kind === 'service'
            ? `service:${sender.name}`
            : prefixed
              ? `person:${sender.name}`
              : sender.name;
      return [
        sender.tokenSha256,
        {
          id: sender.tokenSha256.slice(0, 16),
          kind: sender.kind,
          actor,
          projects: new Map(Object.entries(sender.projects)),
        },
      ];
    }),
  );
}

export interface Adapter {
  readonly server: Server;
  readonly engine: Engine;
}

export function createAdapter(
  config: AdapterConfig,
  options: { readonly githubToken: string; readonly githubSpacing?: number },
): Adapter {
  const github = new GitHub(config.githubApi, options.githubToken, { spacing: options.githubSpacing ?? 0 });
  const engine = new Engine(config, github, new Ledger(config.ledger));
  const signedIn = senders(config);
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      response.end(body === null ? '' : JSON.stringify(body));
    };
    const path = (request.url ?? '/').split('?')[0];
    if (path !== MCP_PATH) return send(404, { error: 'not_found' });
    if (request.method !== 'POST') return send(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    const token = /^Bearer (\S+)$/u.exec(request.headers.authorization ?? '')?.[1];
    const sender = token === undefined ? undefined : signedIn.get(tokenHash(token));
    if (sender === undefined) return send(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_BYTES) chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > BODY_BYTES)
        return send(413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message too large' } });
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      answer(engine, sender, message as Record<string, unknown>).then(
        (reply) => (reply === null ? send(202, null) : send(200, reply)),
        (error: unknown) => send(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: String(error) } }),
      );
    });
  });
  return { server, engine };
}
