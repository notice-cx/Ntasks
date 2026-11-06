import { describe, expect, it } from 'vitest';
import { parseDoltJson } from '../src/dolt-client.ts';
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
    expect(server.sent.length).toBeGreaterThan(10);
    for (const sql of server.sent) {
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
    const changing = async (sql: string) => (sql === state ? [stateAt((reads += 1))] : server(sql));
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
    expect(description).toContain("Each runs as: dolt sql --result-format=json --query '<query>'");
  });

  it('refuses a database name it could not quote safely', () => {
    expect(() =>
      readHubFile(JSON.stringify({ client: ['dolt'], projects: [{ database: 'x`; DROP', key: 'k', name: 'n' }] })),
    ).toThrow('projects[0].database must be a database name.');
  });
});

describe("Dolt's JSON result format", () => {
  it('reads rows, an empty result, and the last line after a USE', () => {
    expect(parseDoltJson('{"rows": [{"a":1}]}\n')).toEqual([{ a: 1 }]);
    expect(parseDoltJson('{}\n')).toEqual([]);
    expect(parseDoltJson('\n{"rows": [{"b":"x"}]}\n')).toEqual([{ b: 'x' }]);
  });

  it('refuses output that is not a result', () => {
    expect(() => parseDoltJson('{"error": "x"}')).toThrow('no rows list');
    expect(() => parseDoltJson('Access denied')).toThrow();
  });
});
