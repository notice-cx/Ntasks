/**
 * Provisioning a new deployment that nobody signs in to, such as the one a
 * product demo runs inside its own stack: the D1 statements that create the
 * sign-in schema, one workspace, its owner of record and its service
 * credentials, and each credential's token. tools/migrate/README.md
 * describes the request and the file.
 *
 * The rows are the ones the Worker writes itself (workers/api/src/access):
 * a credential stores only its secret's SHA-256, and its token is
 * `ntasks_service.<credential id>.<secret>`.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isJsonObject } from './json.ts';
import type { Refusal } from './plan.ts';

export const PROVISION_REQUEST_FORMAT = 'ntasks-provision-request-v1';
export const PROVISION_FORMAT = 'ntasks-provision-v1';

/** D1's migration files, which `wrangler d1 migrations apply` reads. */
export const D1_MIGRATIONS = fileURLToPath(new URL('../../../workers/api/migrations/', import.meta.url));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** A credential's name, as POST /api/access/services takes it. */
const CREDENTIAL_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
const SERVICE_TOKEN_PREFIX = 'ntasks_service';

export interface Statement {
  readonly sql: string;
  readonly values: readonly (string | number | null)[];
}

export interface ProvisionFile {
  readonly format: typeof PROVISION_FORMAT;
  readonly workspaceId: string;
  /** Run in order, on an empty D1 database, as one batch. */
  readonly statements: readonly Statement[];
  /** Each credential's bearer token, by its name. */
  readonly tokens: Readonly<Record<string, string>>;
}

/**
 * The statements of one SQL file, in order: split at each semicolon outside a
 * quoted string, a comment and the body of a trigger, with comments left out.
 * D1 prepares one statement at a time.
 */
export function sqlStatements(text: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;
  // Inside a CREATE TRIGGER's BEGIN … END, where semicolons end the body's own
  // statements; CASE … END nests within it.
  let depth = 0;
  let trigger = false;
  const word = (at: number): string => /^[A-Za-z_]+/u.exec(text.slice(at))?.[0] ?? '';
  while (index < text.length) {
    const char = text[index]!;
    if (char === '-' && text[index + 1] === '-') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === close && text[end + 1] === close && close !== ']') end += 2;
        else if (text[end] === close) break;
        else end += 1;
      }
      current += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_]/u.test(char) && (index === 0 || !/[A-Za-z0-9_]/u.test(text[index - 1]!))) {
      const token = word(index);
      const upper = token.toUpperCase();
      if (upper === 'TRIGGER' && /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?$/iu.test(current)) trigger = true;
      if (trigger && upper === 'BEGIN') depth += 1;
      else if (trigger && depth > 0 && upper === 'CASE') depth += 1;
      else if (trigger && depth > 0 && upper === 'END') depth -= 1;
      current += token;
      index += token.length;
      continue;
    }
    if (char === ';' && depth === 0) {
      if (current.trim() !== '') statements.push(current.trim());
      current = '';
      trigger = false;
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.trim() !== '') statements.push(current.trim());
  return statements;
}

/** D1's migrations in number order, each with its statements, from `folder`. */
export function d1Migrations(folder = D1_MIGRATIONS): { readonly name: string; readonly statements: string[] }[] {
  return readdirSync(folder)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort()
    .map((name) => ({ name, statements: sqlStatements(readFileSync(path.join(folder, name), 'utf8')) }));
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The provision a request makes, or every reason it is refused. `random`
 * gives each credential's secret; `now` the time each row records.
 */
export function planProvision(
  value: unknown,
  options: { readonly now?: () => string; readonly migrations?: string; readonly random?: () => string } = {},
): { readonly file: ProvisionFile | null; readonly refusals: readonly Refusal[] } {
  const refusals: Refusal[] = [];
  const refuse = (subject: string, reason: string) => refusals.push({ subject, reason });
  if (!isJsonObject(value) || value.format !== PROVISION_REQUEST_FORMAT)
    return { file: null, refusals: [{ subject: 'request', reason: `format is not ${PROVISION_REQUEST_FORMAT}` }] };
  for (const key of Object.keys(value))
    if (!['format', 'workspace', 'owner', 'credentials'].includes(key))
      refuse('request', `${key} is not a field of a request`);
  const workspace = isJsonObject(value.workspace) ? value.workspace : null;
  const id = workspace?.id;
  const name = typeof workspace?.name === 'string' ? workspace.name.trim() : '';
  if (typeof id !== 'string' || !UUID.test(id)) refuse('workspace', 'id is a lowercase UUID');
  if (name.length < 1 || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name))
    refuse('workspace', 'name is one line of 1 to 128 characters');
  const owner = isJsonObject(value.owner) && typeof value.owner.name === 'string' ? value.owner.name.trim() : '';
  if (owner.length < 1 || owner.length > 255) refuse('owner', 'name is 1 to 255 characters');
  const credentials = Array.isArray(value.credentials) ? value.credentials : [];
  if (!Array.isArray(value.credentials) || credentials.length === 0)
    refuse('request', 'credentials lists at least one credential');
  const names = new Set<string>();
  for (const [index, entry] of credentials.entries()) {
    const subject =
      isJsonObject(entry) && typeof entry.name === 'string' ? `credential ${entry.name}` : `credential ${index + 1}`;
    if (!isJsonObject(entry)) {
      refuse(subject, 'a credential is an object');
      continue;
    }
    for (const key of Object.keys(entry))
      if (!['name', 'grants', 'backup', 'restore'].includes(key))
        refuse(subject, `${key} is not a field of a credential`);
    if (typeof entry.name !== 'string' || !CREDENTIAL_NAME.test(entry.name))
      refuse(subject, 'name is 1 to 64 letters, digits, spaces, dots, dashes or underscores');
    else if (names.has(entry.name)) refuse(subject, 'another credential has the same name');
    else names.add(entry.name);
    for (const choice of ['backup', 'restore'] as const)
      if (entry[choice] !== undefined && typeof entry[choice] !== 'boolean')
        refuse(subject, `${choice} is true or false`);
    const grants = entry.grants ?? [];
    if (!Array.isArray(grants) || grants.length > 200) refuse(subject, 'grants lists at most 200 projects');
    else {
      const projects = new Set<string>();
      for (const grant of grants) {
        if (
          !isJsonObject(grant) ||
          typeof grant.projectId !== 'string' ||
          grant.projectId.length < 1 ||
          grant.projectId.length > 255 ||
          (grant.access !== 'read' && grant.access !== 'write')
        )
          refuse(subject, 'a grant is { "projectId", "access": "read" | "write" }');
        else if (projects.has(grant.projectId)) refuse(subject, `two grants name the project ${grant.projectId}`);
        else projects.add(grant.projectId);
      }
      if (grants.length === 0 && entry.backup !== true && entry.restore !== true)
        refuse(subject, 'a credential with no grants is made for backups or loads: give backup or restore');
    }
  }
  if (refusals.length > 0) return { file: null, refusals };

  const now = options.now ?? (() => new Date().toISOString());
  const random = options.random ?? (() => randomBytes(32).toString('base64url'));
  const at = now();
  const statements: Statement[] = [
    // Wrangler records each applied migration here, so a later `migrations apply` adds only newer files.
    {
      sql: 'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
      values: [],
    },
  ];
  for (const migration of d1Migrations(options.migrations)) {
    for (const sql of migration.statements) statements.push({ sql, values: [] });
    statements.push({ sql: 'INSERT INTO d1_migrations (name) VALUES (?)', values: [migration.name] });
  }
  const userId = randomUUID();
  // The owner of record is a person who cannot sign in: no GitHub account names them.
  statements.push(
    {
      sql: 'INSERT INTO auth_user (id, name, email, email_verified, image, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, ?, ?)',
      values: [userId, owner, `${userId}@provisioned.invalid`, at, at],
    },
    {
      sql: 'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      values: [id as string, name, userId, at],
    },
    {
      sql: "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      values: [id as string, userId, at],
    },
  );
  const tokens: Record<string, string> = {};
  for (const entry of credentials as Record<string, unknown>[]) {
    const credentialId = randomUUID();
    const secret = random();
    tokens[entry.name as string] = `${SERVICE_TOKEN_PREFIX}.${credentialId}.${secret}`;
    statements.push({
      sql: 'INSERT INTO access_service_credentials (id, workspace_id, name, secret_hash, created_by, created_at, backup, restore) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      values: [
        credentialId,
        id as string,
        entry.name as string,
        sha256(secret),
        userId,
        at,
        entry.backup === true ? 1 : 0,
        entry.restore === true ? 1 : 0,
      ],
    });
    for (const grant of (entry.grants ?? []) as { projectId: string; access: string }[])
      statements.push({
        sql: 'INSERT INTO access_service_grants (credential_id, project_id, access) VALUES (?, ?, ?)',
        values: [credentialId, grant.projectId, grant.access],
      });
  }
  return { file: { format: PROVISION_FORMAT, workspaceId: id as string, statements, tokens }, refusals: [] };
}
