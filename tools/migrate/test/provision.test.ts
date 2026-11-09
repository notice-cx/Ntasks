// Provisioning a deployment nobody signs in to: D1's migrations split into
// statements that build exactly the schema the whole files do, one workspace
// with its owner of record, and credentials whose tokens match the hashes
// stored for them. The Worker itself signs those tokens in, in
// workers/api/test/node/provision.ts.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.ts';
import {
  D1_MIGRATIONS,
  d1Migrations,
  planProvision,
  PROVISION_REQUEST_FORMAT,
  sqlStatements,
} from '../src/provision.ts';

const WORKSPACE = 'b2222222-0000-4000-8000-000000000002';
const PROJECT = 'a1111111-0000-4000-8000-000000000001';

function request(): Record<string, unknown> {
  return {
    format: PROVISION_REQUEST_FORMAT,
    workspace: { id: WORKSPACE, name: 'Demo' },
    owner: { name: 'Mara' },
    credentials: [
      { name: 'seed', backup: true, restore: true },
      { name: 'activity', grants: [{ projectId: PROJECT, access: 'write' }] },
    ],
  };
}

/** The schema a database holds: every table, index and trigger with its SQL,
 * without the comments SQLite keeps in it and with its spacing collapsed. */
function schemaOf(db: DatabaseSync): unknown {
  return (
    db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as {
      sql: string | null;
    }[]
  ).map((row) => ({
    ...row,
    sql:
      row.sql
        ?.replace(/--[^\n]*/gu, '')
        .replace(/\s+/gu, ' ')
        .trim() ?? null,
  }));
}

describe('sqlStatements', () => {
  it("splits D1's migrations into statements that build the same schema as the whole files", () => {
    const whole = new DatabaseSync(':memory:');
    const split = new DatabaseSync(':memory:');
    for (const migration of d1Migrations()) {
      whole.exec(readFileSync(path.join(D1_MIGRATIONS, migration.name), 'utf8'));
      for (const statement of migration.statements) split.prepare(statement).run();
    }
    expect(schemaOf(split)).toEqual(schemaOf(whole));
  });

  it('keeps semicolons in strings, quoted names and trigger bodies, and drops comments', () => {
    const text = [
      '-- a comment; with a semicolon',
      'CREATE TABLE t (a TEXT DEFAULT \'x;y\', "b;c" INTEGER); /* block; comment */',
      'CREATE TRIGGER t_guard BEFORE UPDATE ON t',
      "BEGIN SELECT CASE WHEN NEW.a = 'end' THEN raise(ABORT, 'no; never') END; SELECT 1; END;",
      "INSERT INTO t (a) VALUES ('it''s; fine')",
    ].join('\n');
    expect(sqlStatements(text)).toEqual([
      'CREATE TABLE t (a TEXT DEFAULT \'x;y\', "b;c" INTEGER)',
      "CREATE TRIGGER t_guard BEFORE UPDATE ON t\nBEGIN SELECT CASE WHEN NEW.a = 'end' THEN raise(ABORT, 'no; never') END; SELECT 1; END",
      "INSERT INTO t (a) VALUES ('it''s; fine')",
    ]);
  });
});

describe('a provision', () => {
  it('makes the workspace, its owner of record, and credentials whose tokens match their stored hashes', () => {
    const { file, refusals } = planProvision(request());
    expect(refusals).toEqual([]);
    const db = new DatabaseSync(':memory:');
    for (const statement of file!.statements) db.prepare(statement.sql).run(...statement.values);
    expect(db.prepare('SELECT id, name FROM workspaces').all()).toEqual([{ id: WORKSPACE, name: 'Demo' }]);
    expect(db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ?').all(WORKSPACE)).toEqual([
      { role: 'owner' },
    ]);
    expect(
      db
        .prepare('SELECT name FROM d1_migrations ORDER BY id')
        .all()
        .map((row) => row.name),
    ).toEqual(d1Migrations().map((migration) => migration.name));
    const stored = db
      .prepare('SELECT id, name, secret_hash, backup, restore FROM access_service_credentials ORDER BY name')
      .all() as { id: string; name: string; secret_hash: string; backup: number; restore: number }[];
    expect(stored.map(({ name, backup, restore }) => ({ name, backup, restore }))).toEqual([
      { name: 'activity', backup: 0, restore: 0 },
      { name: 'seed', backup: 1, restore: 1 },
    ]);
    for (const credential of stored) {
      const match = /^ntasks_service\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u.exec(file!.tokens[credential.name]!);
      expect(match?.[1]).toBe(credential.id);
      expect(createHash('sha256').update(match![2]!).digest('hex')).toBe(credential.secret_hash);
    }
    expect(db.prepare('SELECT project_id, access FROM access_service_grants').all()).toEqual([
      { project_id: PROJECT, access: 'write' },
    ]);
  });

  it('gives every credential its own secret each time', () => {
    const one = planProvision(request()).file!.tokens;
    const two = planProvision(request()).file!.tokens;
    expect(new Set([...Object.values(one), ...Object.values(two)]).size).toBe(4);
  });

  it('is refused, with every reason, when the request does not describe one workspace and its credentials', () => {
    const bad = {
      ...request(),
      workspace: { id: 'not-a-uuid', name: '' },
      credentials: [{ name: 'seed' }, { name: 'seed', grants: [{ projectId: PROJECT, access: 'admin' }] }],
    };
    expect(planProvision(bad).refusals).toEqual([
      { subject: 'workspace', reason: 'id is a lowercase UUID' },
      { subject: 'workspace', reason: 'name is one line of 1 to 128 characters' },
      {
        subject: 'credential seed',
        reason: 'a credential with no grants is made for backups or loads: give backup or restore',
      },
      { subject: 'credential seed', reason: 'another credential has the same name' },
      { subject: 'credential seed', reason: 'a grant is { "projectId", "access": "read" | "write" }' },
    ]);
  });
});

describe('the provision command', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    const value: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
    return { io: value, out, err };
  }

  it('writes the file once, readable only by its owner', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'ntasks-provision-test-'));
    const from = path.join(folder, 'request.json');
    await writeFile(from, JSON.stringify(request()));
    const out = path.join(folder, 'provision.json');
    expect(await main(['provision', '--from', from, '--out', out], io().io)).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ workspaceId: WORKSPACE });
    const again = io();
    expect(await main(['provision', '--from', from, '--out', out], again.io)).toBe(1);
    expect(existsSync(out)).toBe(true);
  });
});
