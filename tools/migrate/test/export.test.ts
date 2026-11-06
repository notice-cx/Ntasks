import { describe, expect, it } from 'vitest';
import { parseDoltJson, stepResults, stepSql } from '../src/dolt-client.ts';
import { databaseQueries, describeExport, exportHub, readHubFile, type HubFile } from '../src/export.ts';
import { fakeServer } from './fake-hub.ts';
import { acmeHub, betaHub } from './scenario.ts';

const hubFile = (hubs: readonly { database: string; key: string; name: string }[]): HubFile => ({
  client: ['dolt', 'sql', '--result-format=json', '--query'],
  projects: hubs.map((hub) => ({ database: hub.database, key: hub.key, name: hub.name })),
});

describe('export', () => {
  it('reads every project in full, with its history', async () => {
    const acme = acmeHub();
    const beta = betaHub();
    const data = await exportHub(
      hubFile([acme, beta]),
      fakeServer([acme, beta]),
      () => new Date('2026-03-03T00:00:00.000Z'),
    );
    expect(data).toEqual({
      format: 'ntasks-beads-export-v1',
      exportedAt: '2026-03-03T00:00:00.000Z',
      doltVersion: '2.4.0',
      projects: [acme.project(), beta.project()],
    });
  });

  it('sends only read-only queries', async () => {
    const acme = acmeHub();
    const server = fakeServer([acme]);
    await exportHub(hubFile([acme]), server);
    expect(server.steps.flat().length).toBeGreaterThan(10);
    for (const sql of server.steps.flat()) {
      expect(sql).toMatch(
        /^(SELECT |USE `acme_tasks`; SELECT DOLT_HASHOF\('HEAD'\) AS head, DOLT_HASHOF_DB\('WORKING'\))/u,
      );
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CALL|CREATE|DROP|ALTER|REPLACE|GRANT)\b/iu);
    }
  });

  it.each([
    ['written to', (reads: number) => ({ head: 'c1', working: `w${reads}` })],
    // A commit of changes already in the working set leaves its hash as it was.
    ['committed to', (reads: number) => ({ head: `c${reads}`, working: 'w1' })],
  ])('refuses a hub %s while it was read', async (_, stateAt) => {
    const acme = acmeHub();
    const server = fakeServer([acme]);
    const state = databaseQueries('acme_tasks').state;
    let reads = 0;
    const changing = async (queries: readonly string[]) =>
      queries[0] === state ? [[stateAt((reads += 1))]] : server(queries);
    await expect(exportHub(hubFile([acme]), changing)).rejects.toThrow('acme_tasks changed while the export read it');
  });

  it('refuses a database that is not the project the hub file names', async () => {
    const acme = acmeHub();
    const hub: HubFile = {
      client: ['dolt'],
      projects: [{ database: 'acme_tasks', key: 'acme', name: 'Acme', prefix: 'other' }],
    };
    await expect(exportHub(hub, fakeServer([acme]))).rejects.toThrow(
      'acme_tasks uses the prefix acme, not other as the hub file says.',
    );
  });

  it('lists every query it would send without sending any', () => {
    const description = describeExport(hubFile([acmeHub()]));
    expect(description).toContain('SELECT * FROM `acme_tasks`.`dolt_diff_issues`');
    expect(description).toContain(
      "USE `acme_tasks`; SELECT DOLT_HASHOF('HEAD') AS head, DOLT_HASHOF_DB('WORKING') AS working",
    );
    expect(description).toContain("Each step runs as: dolt sql --result-format=json --query '<the step's queries>'");
  });

  it('refuses a database name it could not quote safely', () => {
    expect(() =>
      readHubFile(JSON.stringify({ client: ['dolt'], projects: [{ database: 'x`; DROP', key: 'k', name: 'n' }] })),
    ).toThrow('projects[0].database must be a database name.');
  });
});

it('reads everything it keeps in one step, after the first state check and before the second', async () => {
  const acme = acmeHub();
  const beta = betaHub();
  const server = fakeServer([acme, beta]);
  await exportHub(hubFile([acme, beta]), server);
  const state = (database: string) => databaseQueries(database).state;
  expect(server.steps.map((step) => step.length)).toEqual([1, 2, 3, 3, server.steps[4]!.length, 2]);
  expect(server.steps[1]).toEqual([state('acme_tasks'), state('beta_tasks')]);
  expect(server.steps[5]).toEqual([state('acme_tasks'), state('beta_tasks')]);
  const snapshot = server.steps[4]!;
  expect(snapshot).toContain('SELECT * FROM `acme_tasks`.`dolt_diff_issues`');
  expect(snapshot).toContain('SELECT * FROM `beta_tasks`.`comments`');
  // Every database is touched first, so the transaction reads them all at its start.
  expect(snapshot.slice(0, 2)).toEqual([
    'SELECT COUNT(*) AS count FROM `acme_tasks`.`comments`',
    'SELECT COUNT(*) AS count FROM `acme_tasks`.`config`',
  ]);
});

it('refuses when an earlier project changed while a later one was read', async () => {
  const acme = acmeHub();
  const beta = betaHub();
  const server = fakeServer([acme, beta]);
  const state = databaseQueries('acme_tasks').state;
  let checks = 0;
  const changing = async (queries: readonly string[]) => {
    const answers = await server(queries);
    if (queries[0] !== state) return answers;
    checks += 1;
    return checks === 1 ? answers : [[{ head: 'moved', working: 'moved' }], ...answers.slice(1)];
  };
  await expect(exportHub(hubFile([acme, beta]), changing)).rejects.toThrow(
    'acme_tasks changed while the export read it',
  );
});

describe('one step through the SQL client', () => {
  it('runs the queries in a read-only transaction it rolls back, each after a marker', () => {
    expect(stepSql(['SELECT 1 AS a', 'USE `db`; SELECT 2 AS b'], 'm')).toBe(
      "START TRANSACTION READ ONLY; SELECT 'm:0' AS ntasks_query; SELECT 1 AS a; SELECT 'm:1' AS ntasks_query; USE `db`; SELECT 2 AS b; SELECT 'm:end' AS ntasks_query; ROLLBACK",
    );
  });

  it("reads each query's answer between its marker and the next, as Dolt prints them", () => {
    // As dolt 2.6.1 printed a step: `{}` and an empty line for START TRANSACTION and ROLLBACK, nothing for USE.
    const stdout = [
      '{}',
      '',
      '{"rows": [{"ntasks_query":"m:0"}]}',
      '{"rows": [{"a":1}]}',
      '{"rows": [{"ntasks_query":"m:1"}]}',
      '{}',
      '',
      '{"rows": [{"ntasks_query":"m:2"}]}',
      '{"rows": [{"head":"h","working":"w"}]}',
      '{"rows": [{"ntasks_query":"m:end"}]}',
      '{}',
      '',
    ].join('\n');
    expect(stepResults(stdout, 'm', 3)).toEqual([[{ a: 1 }], [], [{ head: 'h', working: 'w' }]]);
  });

  it('refuses output that does not answer every query', () => {
    expect(() => stepResults('{"rows": [{"ntasks_query":"m:0"}]}\n{}\n', 'm', 1)).toThrow('answered 0 of 1 queries');
    expect(() => parseDoltJson('{"error": "x"}')).toThrow('no rows list');
    expect(() => parseDoltJson('Access denied')).toThrow();
  });
});
