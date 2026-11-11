// What each read costs the task store, on a store the size of a busy
// installation: eight projects, one much larger than the rest, about a
// thousand tasks open and several thousand closed, a quarter of them linking
// a pull request, every one with the values of two custom fields, and a
// quarter of the closed ones recording where their change is. The free
// plan allows 5
// million rows read per day and refuses reads for the rest of the day once
// that allowance is spent; these budgets keep each read far inside it. They
// measure a read the store has not cached; a cached one reads no rows
// (store.test.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import { newMeter, type Meter } from '../../src/store/sqlite.ts';
import { storeDatabase } from '../store.ts';
import { api, get, read, send, WRITER, type TestApi } from './helpers.ts';

const NOW = '2026-11-06T12:00:00.000Z';
/** Each project's task count and how many of those are not closed. */
const SIZES = [
  [3000, 400],
  [600, 85],
  [600, 85],
  [600, 85],
  [600, 85],
  [600, 85],
  [600, 85],
  [600, 85],
] as const;
/** Closed in the last week, per project; the rest closed earlier. */
const RECENTLY_CLOSED = 20;
/** A label every project carries on a few tasks, half of them closed long ago:
 * the label read's cost follows these, not the project's size. */
const TRIAGE = 'triage';
const TRIAGED = [1, 2, 3, 4, 5, 6, 500, 501, 502, 503, 504, 505];

const meter = newMeter();
const db = storeDatabase();
let target: TestApi;
let big: { id: string; prefix: string };
/** Every seeded project, in the order of SIZES. */
const seeded: { id: string; prefix: string }[] = [];

/** Fills one project with `total` tasks, of which the first `active` are not
 * closed. From `first`, it adds tasks `first` to `total` to a project seeded before. */
async function seed(projectId: string, prefix: string, total: number, active: number, first = 1): Promise<void> {
  // A bound number arrives as a real; the cast writes ids such as t1, not t1.0.
  const numbers = 'WITH RECURSIVE n(i) AS (SELECT CAST(?7 AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < ?3)';
  const added = 'CAST(substr(id, length(?2) + 3) AS INTEGER) >= ?7';
  const id = (expression: string) => `?2 || '-t' || (${expression})`;
  const statements = [
    `${numbers}
     INSERT INTO tasks (id, project_id, parent_id, type, status, priority, title, description, acceptance, defer_until,
       created_at, updated_at, closed_at, resolution, close_reason, filed_by)
     SELECT ${id('i')}, ?1,
       CASE WHEN i <= ?4 AND i % 25 <> 1 AND i % 2 = 0 THEN ${id('i - ((i - 1) % 25)')} END,
       CASE WHEN i <= ?4 AND i % 25 = 1 THEN 'epic' WHEN i % 4 = 0 THEN 'bug' ELSE 'task' END,
       CASE WHEN i > ?4 THEN 'closed' WHEN i % 10 = 3 THEN 'in_progress' WHEN i % 10 = 7 THEN 'deferred' ELSE 'open' END,
       i % 5,
       'Seeded task ' || i || ' about indexing pages',
       'WHAT: ' || replace(hex(zeroblob(200)), '00', 'pages ') || char(10) || 'WHY: seeded',
       'The seeded check passes.',
       CASE WHEN i <= ?4 AND i % 10 = 7 THEN '2027-01-01T00:00:00.000Z' END,
       strftime('%Y-%m-%dT%H:%M:%fZ', ?5, '-' || i || ' hours'),
       strftime('%Y-%m-%dT%H:%M:%fZ', ?5, '-' || (i - 1) || ' hours'),
       CASE WHEN i > ?4 + ?6 THEN strftime('%Y-%m-%dT%H:%M:%fZ', ?5, '-' || (i - ?4) || ' days')
            WHEN i > ?4 THEN strftime('%Y-%m-%dT%H:%M:%fZ', ?5, '-' || (i - ?4) || ' hours') END,
       CASE WHEN i > ?4 THEN 'done' END,
       CASE WHEN i > ?4 THEN 'Shipped.' END,
       'seed'
     FROM n`,
    `${numbers}
     INSERT INTO task_edges (task_id, depends_on_id, type, created_at)
     SELECT ${id('i')}, ${id('i - 1')}, CASE WHEN i <= ?4 THEN 'blocks' ELSE 'discovered-from' END, ?5 FROM n WHERE i % 3 = 0`,
    `${numbers}
     INSERT INTO task_external_links (task_id, url, title, kind, created_at)
     SELECT ${id('i')}, 'https://example.com/' || ?2 || '/pull/' || i, 'Seeded change ' || i, 'pull-request', ?5
     FROM n WHERE i % 4 = 2`,
    ...(first === 1
      ? [
          `INSERT INTO custom_fields (project_id, key, name, type, options, created_at) VALUES
             (?1, 'severity', 'Severity', 'single-choice', '["low","medium","high"]', ?5),
             (?1, 'points', 'Points', 'number', NULL, ?5)`,
        ]
      : []),
    `UPDATE tasks SET version = version + 1, field_values = json_object(
       'severity', CASE CAST(substr(id, length(?2) + 3) AS INTEGER) % 3 WHEN 0 THEN 'low' WHEN 1 THEN 'medium' ELSE 'high' END,
       'points', CAST(substr(id, length(?2) + 3) AS INTEGER) % 8)
     WHERE project_id = ?1 AND ${added}`,
    // One in ten of these is built, waiting for its merge; the rest are live.
    `UPDATE tasks SET version = version + 1,
       delivery_stage = CASE WHEN CAST(substr(id, length(?2) + 3) AS INTEGER) % 40 = 2 THEN 'built' ELSE 'live' END,
       delivery_pull_request = 'https://example.com/' || ?2 || '/pull/' || substr(id, length(?2) + 3),
       delivery_commit = printf('%08x', (CAST(substr(id, length(?2) + 3) AS INTEGER) * ${SPREAD} + unicode(substr(?2, -1)))
         % 4294967296) || lower(hex(?2)),
       built_at = closed_at,
       live_at = CASE WHEN CAST(substr(id, length(?2) + 3) AS INTEGER) % 40 = 2 THEN NULL ELSE closed_at END
     WHERE project_id = ?1 AND status = 'closed' AND CAST(substr(id, length(?2) + 3) AS INTEGER) % 4 = 2 AND ${added}`,
    `${numbers}
     INSERT INTO task_labels (task_id, label)
     SELECT ${id('i')}, 'area-' || (i % 7) FROM n UNION ALL SELECT ${id('i')}, 'seo' FROM n WHERE i % 5 = 0`,
    `${numbers}, k(j) AS (VALUES (1), (2), (3))
     INSERT INTO task_comments (id, task_id, author, text, created_at)
     SELECT ?2 || '-c' || i || '-' || j, ${id('i')}, 'seed', 'Progress note ' || j, ?5 FROM n, k WHERE j = 1 OR i % 4 = 0`,
    `${numbers}
     INSERT INTO task_events (task_id, project_id, version, kind, actor, at, changes)
     SELECT ${id('i')}, ?1, 1, 'created', 'seed', ?5, json_object('title', 'Seeded task ' || i) FROM n`,
  ];
  const values = [projectId, prefix, total, active, NOW, RECENTLY_CLOSED, first];
  for (const sql of statements) {
    // SQLite takes exactly as many values as the statement's highest ?N.
    const used = Math.max(...Array.from(sql.matchAll(/\?(\d)/gu), (match) => Number(match[1])));
    await db
      .prepare(sql)
      .bind(...values.slice(0, used))
      .run();
  }
}

beforeAll(async () => {
  const setUp = api({ now: () => NOW });
  const run = crypto
    .randomUUID()
    .replaceAll('-', '')
    .slice(0, 6)
    .replace(/^[0-9]/u, 'x');
  for (const [index, [total, active]] of SIZES.entries()) {
    const prefix = `c${run}${String.fromCharCode(97 + index)}`;
    const project = await setUp.engine.createProject({
      id: crypto.randomUUID(),
      key: `${prefix}.example.com`,
      name: `Cost ${index}`,
      prefix,
    });
    await seed(project.id, prefix, total, active);
    seeded.push({ id: project.id, prefix });
    for (const i of TRIAGED) {
      await db
        .prepare('INSERT INTO task_labels (task_id, label) VALUES (?1, ?2)')
        .bind(`${prefix}-t${i}`, TRIAGE)
        .run();
    }
  }
  big = seeded[0]!;
  target = api({ now: () => NOW, meter });
}, 60_000);

/** Spreads the seeded commits over the hexadecimal range, as real ones are, so
 * no two tasks share their first characters (Knuth's multiplicative hash). */
const SPREAD = 2654435761;

/** The commit the seed gives task `i` of the project with this prefix. */
function seededCommit(prefix: string, i: number): string {
  const head = ((i * SPREAD + prefix.charCodeAt(prefix.length - 1)) % 4294967296).toString(16).padStart(8, '0');
  return head + Array.from(new TextEncoder().encode(prefix), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What one read cost. */
async function costOf(work: () => Promise<unknown>): Promise<Meter> {
  Object.assign(meter, newMeter());
  await work();
  return { ...meter };
}

/**
 * Each read's most statements and rows read on this store. A read of one
 * task costs what that task and its links cost, and one statement more for
 * its parent's pinned comments and closed children; a list costs about ten rows
 * for each task it returns. The statements do not grow with the number of
 * projects. list_tasks reads the external links of the page it returns in a
 * statement of its own, after the board. Agent statistics read one row for
 * each task in progress, blocked or closed in the last eight weeks. The wins
 * feed reads one row for each task not closed and each closed in the last
 * five weeks, and the children of the epics it finds finished. The burn-down
 * reads one index entry for each task not closed, and a row for each closed
 * in the last eight weeks.
 */
const BUDGETS: Record<string, { readonly statements: number; readonly rowsRead: number }> = {
  'HTTP board, largest project': { statements: 5, rowsRead: 7_000 },
  'HTTP task page': { statements: 4, rowsRead: 60 },
  'HTTP task history': { statements: 3, rowsRead: 60 },
  'HTTP change feed, 200 changes': { statements: 1, rowsRead: 250 },
  'HTTP label read, 12 tasks in the largest project': { statements: 2, rowsRead: 300 },
  'HTTP label read, a page of 200 in the largest project': { statements: 2, rowsRead: 3_500 },
  list_projects: { statements: 1, rowsRead: 20 },
  'list_tasks ready, every project': { statements: 3, rowsRead: 10_000 },
  'list_tasks, every project': { statements: 4, rowsRead: 16_000 },
  'list_tasks search, every project': { statements: 4, rowsRead: 22_000 },
  'HTTP search, every project': { statements: 4, rowsRead: 22_000 },
  'list_tasks, largest project': { statements: 4, rowsRead: 6_000 },
  'list_tasks by a field, largest project': { statements: 5, rowsRead: 4_000 },
  'HTTP board by a field, largest project': { statements: 6, rowsRead: 5_000 },
  'list_tasks at a stage, largest project': { statements: 4, rowsRead: 1_000 },
  'HTTP board at a stage, largest project': { statements: 5, rowsRead: 1_000 },
  // A call that names a task reads whether the id is a moved task's former id: one statement, no rows when it is not.
  get_task: { statements: 5, rowsRead: 60 },
  get_task_history: { statements: 4, rowsRead: 60 },
  'get_agent_stats, every project': { statements: 2, rowsRead: 800 },
  'HTTP agent stats, largest project': { statements: 2, rowsRead: 150 },
  'HTTP wins, every project': { statements: 4, rowsRead: 2_000 },
  'HTTP wins, largest project': { statements: 4, rowsRead: 700 },
  'HTTP burn-down, every project': { statements: 3, rowsRead: 2_000 },
  'HTTP burn-down, largest project': { statements: 3, rowsRead: 700 },
};

describe('the cost of each read', () => {
  it('stays inside its budget on a store this size', async () => {
    const task = `${big.prefix}-t2`;
    const reads: Record<string, () => Promise<unknown>> = {
      'HTTP board, largest project': () => get(target, `/api/tasks?project=${big.id}`),
      'HTTP task page': () => get(target, `/api/tasks/${task}?project=${big.id}`),
      'HTTP task history': () => get(target, `/api/tasks/${task}/history?project=${big.id}`),
      'HTTP change feed, 200 changes': () => get(target, '/api/changes?after=0&limit=200'),
      'HTTP label read, 12 tasks in the largest project': () =>
        get(target, `/api/tasks?project=${big.id}&label=${TRIAGE}`),
      'HTTP label read, a page of 200 in the largest project': () =>
        get(target, `/api/tasks?project=${big.id}&label=seo&limit=200`),
      list_projects: () => read(target, 'list_projects'),
      'list_tasks ready, every project': () => read(target, 'list_tasks', { ready: true }),
      'list_tasks, every project': () => read(target, 'list_tasks', {}),
      'list_tasks search, every project': () => read(target, 'list_tasks', { query: 'seeded indexing' }),
      'HTTP search, every project': () => get(target, '/api/tasks/search?q=seeded%20indexing'),
      'list_tasks, largest project': () => read(target, 'list_tasks', { project: big.id }),
      'list_tasks by a field, largest project': () =>
        read(target, 'list_tasks', { project: big.id, fields: { severity: 'high' } }),
      'HTTP board by a field, largest project': () => get(target, `/api/tasks?project=${big.id}&field.severity=high`),
      'list_tasks at a stage, largest project': () => read(target, 'list_tasks', { project: big.id, stage: 'built' }),
      'HTTP board at a stage, largest project': () => get(target, `/api/tasks?project=${big.id}&stage=built`),
      get_task: () => read(target, 'get_task', { project: big.id, task }),
      get_task_history: () => read(target, 'get_task_history', { project: big.id, task }),
      'get_agent_stats, every project': () => read(target, 'get_agent_stats'),
      'HTTP agent stats, largest project': () => get(target, `/api/tasks/agent-stats?project=${big.id}`),
      'HTTP wins, every project': () => get(target, '/api/tasks/wins'),
      'HTTP wins, largest project': () => get(target, `/api/tasks/wins?project=${big.id}`),
      'HTTP burn-down, every project': () => get(target, '/api/tasks/burndown'),
      'HTTP burn-down, largest project': () => get(target, `/api/tasks/burndown?project=${big.id}`),
    };
    expect(Object.keys(reads)).toEqual(Object.keys(BUDGETS));
    const costs: Record<string, Meter> = {};
    for (const [name, work] of Object.entries(reads)) costs[name] = await costOf(work);
    // Shown with --silent=false, to compare a change against these numbers.
    console.log(JSON.stringify(costs));
    for (const [name, cost] of Object.entries(costs)) {
      const budget = BUDGETS[name]!;
      expect(cost.statements, name).toBeLessThanOrEqual(budget.statements);
      expect(cost.rowsRead, name).toBeLessThanOrEqual(budget.rowsRead);
    }
  }, 60_000);

  it('reads a label through its index: the cost follows the tasks carrying it, not the project', async () => {
    const triaged = await costOf(() => get(target, `/api/tasks?project=${big.id}&label=${TRIAGE}`));
    const small = await costOf(async () => {
      const [, other] = await read<{ projects: { projectId: string }[] }>(target, 'list_projects').then(
        (body) => body.projects,
      );
      Object.assign(meter, newMeter());
      return get(target, `/api/tasks?project=${other!.projectId}&label=${TRIAGE}`);
    });
    const [total] = SIZES[0];
    expect(triaged.rowsRead).toBeLessThan(total / 10);
    // Eight times the tasks in the project, the same twelve carrying the label: about the same cost.
    expect(Math.abs(triaged.rowsRead - small.rowsRead)).toBeLessThan(60);
    const page = await get(target, `/api/tasks?project=${big.id}&label=${TRIAGE}`);
    expect((page.body.tasks as { id: string }[]).map((task) => task.id).sort()).toEqual(
      TRIAGED.map((i) => `${big.prefix}-t${i}`).sort(),
    );
  });

  it('answers what was seeded', async () => {
    const board = await get(target, `/api/tasks?project=${big.id}`);
    const [, active] = SIZES[0];
    expect(board.status).toBe(200);
    expect((board.body.tasks as unknown[]).length).toBe(active + RECENTLY_CLOSED);
    const every = await read<{ total: number }>(target, 'list_tasks', {});
    const open = SIZES.reduce((sum, [, count]) => sum + count, 0);
    expect(every.total).toBe(open + RECENTLY_CLOSED * SIZES.length);
    const stats = await read<{ projects: number; stats: { week: number } }>(target, 'get_agent_stats');
    expect(stats).toMatchObject({ projects: SIZES.length, stats: { week: RECENTLY_CLOSED * SIZES.length } });
  });

  it('finds the tasks a delivery signal names through their indexes: the cost follows those tasks, not the project', async () => {
    // Live already, so the signal moves nothing and the store stays as the other reads measure it.
    const named = [426, 430, 434, 438, 446];
    const signal = {
      repository: 'example/app',
      stage: 'merged',
      pullRequests: named.map((i) => `https://example.com/${big.prefix}/pull/${i}`),
      commits: named.map((i) => seededCommit(big.prefix, i).slice(0, 12)),
    };
    const writer = api({ now: () => NOW, meter, principal: WRITER });
    const cost = await costOf(async () =>
      expect(await send(writer, 'POST', '/api/delivery', signal)).toMatchObject({ status: 200, body: { moved: [] } }),
    );
    // The project list, then the named tasks: about ten rows for each one named.
    expect(cost.statements).toBeLessThanOrEqual(2);
    expect(cost.rowsRead).toBeLessThan(200);
  });

  it("reads the agent statistics through the work's indexes: the cost follows the work, not the project", async () => {
    const [total] = SIZES[0];
    const cost = await costOf(() => get(target, `/api/tasks/agent-stats?project=${big.id}`));
    expect(cost.rowsRead).toBeLessThan(total / 20);
  });

  // After the cases that measure the store as seeded, since this one adds to its history.
  it('reads the same rows with ten times the closed history: the board and the lists follow open work and the closed window', async () => {
    const reads: Record<string, () => Promise<unknown>> = {
      // The board's position in the change feed moves with the history added.
      'HTTP board, largest project': async () => {
        const { lastSeq: _, ...board } = (await get(target, `/api/tasks?project=${big.id}`)).body;
        return board;
      },
      'list_tasks, every project': () => read(target, 'list_tasks', {}),
      'list_tasks ready, every project': () => read(target, 'list_tasks', { ready: true }),
      'list_tasks search, every project': () => read(target, 'list_tasks', { query: 'seeded indexing' }),
      'HTTP search, every project': () => get(target, '/api/tasks/search?q=seeded%20indexing'),
      'list_tasks, largest project': () => read(target, 'list_tasks', { project: big.id }),
      'HTTP wins, every project': () => get(target, '/api/tasks/wins'),
      'HTTP burn-down, every project': () => get(target, '/api/tasks/burndown'),
    };
    const measure = async () => {
      const measured: Record<string, { cost: Meter; answer: unknown }> = {};
      for (const [name, work] of Object.entries(reads)) {
        let answer: unknown;
        const cost = await costOf(async () => {
          answer = await work();
        });
        measured[name] = { cost, answer };
      }
      return measured;
    };
    const closed = async () =>
      (await db.prepare("SELECT count(*) AS n FROM tasks WHERE status = 'closed'").first<{ n: number }>())!.n;

    const base = await measure();
    const history = await closed();
    for (const [index, [total, active]] of SIZES.entries()) {
      const { id, prefix } = seeded[index]!;
      await seed(id, prefix, active + 10 * (total - active), active, total + 1);
    }
    expect(await closed()).toBe(10 * history);
    const older = await measure();
    console.log(JSON.stringify(Object.fromEntries(Object.entries(older).map(([name, { cost }]) => [name, cost]))));

    for (const [name, { cost, answer }] of Object.entries(older)) {
      expect(answer, name).toEqual(base[name]!.answer);
      expect(cost.rowsRead, name).toBeLessThanOrEqual(base[name]!.cost.rowsRead * 1.05);
    }
    // A task closed a year ago is still read by its id.
    const [, active] = SIZES[0];
    const yearAgo = new Date(Date.parse(NOW) - 365 * 86_400_000).toISOString();
    const old = await read<{ task: Record<string, unknown> }>(target, 'get_task', {
      project: big.id,
      task: `${big.prefix}-t${active + 365}`,
    });
    expect(old.task).toMatchObject({ status: 'closed', closedAt: yearAgo });
  }, 60_000);

  // Last, since its project would change what the reads of every project above cost.
  it("reads the external links of a page's tasks only, however many the other matching tasks hold", async () => {
    const tasks = 400;
    const links = 32;
    const prefix = `l${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const project = await target.engine.createProject({
      id: crypto.randomUUID(),
      key: `${prefix}.example.com`,
      name: 'Many links',
      prefix,
    });
    const numbers = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)';
    await db
      .prepare(
        `${numbers}
         INSERT INTO tasks (id, project_id, type, status, priority, title, created_at, updated_at, filed_by)
         SELECT ?2 || '-t' || i, ?1, 'task', 'open', 2, 'Linked task ' || i,
           strftime('%Y-%m-%dT%H:%M:%fZ', ?4, '-' || i || ' minutes'), ?4, 'seed' FROM n`,
      )
      .bind(project.id, prefix, tasks, NOW)
      .run();
    await db
      .prepare(
        `${numbers}, k(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM k WHERE j < ?4)
         INSERT INTO task_external_links (task_id, url, title, kind, created_at)
         SELECT ?1 || '-t' || i, 'https://example.com/' || ?1 || '/' || i || '/' || j,
           'Page ' || j || ' of task ' || i, 'document', ?2 FROM n, k`,
      )
      .bind(prefix, NOW, tasks, links)
      .run();

    let page: { total: number; tasks: { id: string; externalLinks: unknown[] }[] } | undefined;
    const cost = await costOf(async () => {
      page = await read(target, 'list_tasks', { project: project.id, limit: 5 });
    });
    console.log(JSON.stringify({ 'list_tasks, 5 of 400 tasks with 32 links each': cost }));
    expect(page!.total).toBe(tasks);
    expect(page!.tasks.map((task) => task.externalLinks.length)).toEqual([links, links, links, links, links]);
    // Reading every matching task's links would read more than tasks * links rows.
    expect(cost.rowsRead).toBeLessThan(5 * (links + 1) + 10 * tasks);
  }, 60_000);
});
