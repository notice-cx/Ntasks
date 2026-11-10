/**
 * What an adapter serves: its projects, each a GitHub repository's issues or
 * those of them with a label, and its senders, each signed in by a token the
 * file stores only as a SHA-256. The GitHub token comes from the environment,
 * never from the file.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The service name the adapter records its own changes under: OWN_ACTOR is `service:` and this. */
export const OWN_SERVICE = 'github-adapter';

export type Access = 'read' | 'write';
export type SenderKind = 'agent' | 'service' | 'person';

export interface ProjectConfig {
  readonly projectId: string;
  /** The name people know the project by. */
  readonly key: string;
  readonly name: string;
  /** Starts each task id: `<prefix>-<issue number>`. Lowercase letters and digits. */
  readonly prefix: string;
  /** `owner/name`. */
  readonly repository: string;
  /** When given, the project is the repository's issues that carry this label. */
  readonly label?: string;
}

export interface SenderConfig {
  readonly kind: SenderKind;
  readonly name: string;
  /** The SHA-256 of the sender's bearer token, as lowercase hexadecimal. */
  readonly tokenSha256: string;
  readonly projects: Readonly<Record<string, Access>>;
}

export interface AdapterConfig {
  /** GitHub's API address: https://api.github.com, or a stand-in's. */
  readonly githubApi: string;
  /** The file the ledger is kept in, or null to keep it in memory only. */
  readonly ledger: string | null;
  readonly projects: readonly ProjectConfig[];
  readonly senders: readonly SenderConfig[];
}

export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

const PREFIX = /^[a-z0-9]{1,32}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** The configuration, or an error naming the field that breaks its rule. */
export function checkConfig(value: AdapterConfig): AdapterConfig {
  const fail = (what: string): never => {
    throw new Error(`config: ${what}`);
  };
  if (!/^https?:\/\//u.test(value.githubApi)) fail('githubApi is an http or https address');
  if (value.projects.length === 0) fail('projects lists at least one project');
  const prefixes = new Set<string>();
  for (const project of value.projects) {
    if (!PREFIX.test(project.prefix)) fail(`${project.projectId}: prefix is 1 to 32 lowercase letters or digits`);
    if (prefixes.has(project.prefix)) fail(`${project.projectId}: another project has the prefix ${project.prefix}`);
    prefixes.add(project.prefix);
    if (!REPOSITORY.test(project.repository)) fail(`${project.projectId}: repository is owner/name`);
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const project of value.projects) {
    if (ids.has(project.projectId)) fail(`another project has the projectId ${project.projectId}`);
    if (keys.has(project.key)) fail(`${project.projectId}: another project has the key ${project.key}`);
    ids.add(project.projectId);
    keys.add(project.key);
  }
  // A sender's kind decides how its changes are recorded; a token signs in one sender only.
  const tokens = new Set<string>();
  for (const sender of value.senders) {
    if (!(['agent', 'service', 'person'] as const).includes(sender.kind))
      fail(`${sender.name}: kind is agent, service or person`);
    // The adapter records its own changes as this service, such as an epic it closes (engine.ts OWN_ACTOR).
    if (sender.kind === 'service' && sender.name === OWN_SERVICE)
      fail(`${sender.name}: the adapter records its own changes under this name; give the service another`);
    if (!/^[0-9a-f]{64}$/u.test(sender.tokenSha256)) fail(`${sender.name}: tokenSha256 is a SHA-256 in hexadecimal`);
    if (tokens.has(sender.tokenSha256)) fail(`${sender.name}: another sender has the same tokenSha256`);
    tokens.add(sender.tokenSha256);
    for (const project of Object.keys(sender.projects))
      if (!ids.has(project)) fail(`${sender.name}: ${project} names no project`);
  }
  return value;
}

export function readConfig(path: string): AdapterConfig {
  return checkConfig(JSON.parse(readFileSync(path, 'utf8')) as AdapterConfig);
}
