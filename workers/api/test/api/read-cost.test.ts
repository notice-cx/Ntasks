// What each read costs the task store, on a store the size of a busy
// installation: eight projects, one much larger than the rest, about a
// thousand tasks open and several thousand closed. The free plan allows 5
// million rows read per day and refuses reads for the rest of the day once
// that allowance is spent; these budgets keep each read far inside it. They
// measure a read the store has not cached; a cached one reads no rows
// (store.test.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import { newMeter, type Meter } from '../../src/store/sqlite.ts';
import { storeDatabase } from '../store.ts';
import { api, get, read, type TestApi } from './helpers.ts';

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

/** Fills one project with `total` tasks, of which the first `active` are not closed. */
async function seed(projectId: string, prefix: string, total: number, active: number): Promise<void> {
  const numbers = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)';
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
     INSERT INTO task_labels (task_id, label)
     SELECT ${id('i')}, 'area-' || (i % 7) FROM n UNION ALL SELECT ${id('i')}, 'seo' FROM n WHERE i % 5 = 0`,
    `${numbers}, k(j) AS (VALUES (1), (2), (3))
     INSERT INTO task_comments (id, task_id, author, text, created_at)
     SELECT ?2 || '-c' || i || '-' || j, ${id('i')}, 'seed', 'Progress note ' || j, ?5 FROM n, k WHERE j = 1 OR i % 4 = 0`,
    `${numbers}
     INSERT INTO task_events (task_id, project_id, version, kind, actor, at, changes)
     SELECT ${id('i')}, ?1, 1, 'created', 'seed', ?5, json_object('title', 'Seeded task ' || i) FROM n`,
  ];
  const values = [projectId, prefix, total, active, NOW, RECENTLY_CLOSED];
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
    for (const i of TRIAGED) {
      await db
        .prepare('INSERT INTO task_labels (task_id, label) VALUES (?1, ?2)')
        .bind(`${prefix}-t${i}`, TRIAGE)
        .run();
    }
    if (index === 0) big = { id: project.id, prefix };
  }
  target = api({ now: () => NOW, meter });
}, 60_000);

/** What one read cost. */
async function costOf(work: () => Promise<unknown>): Promise<Meter> {
  Object.assign(meter, newMeter());
  await work();
  return { ...meter };
}

/**
 * Each read's most statements and rows read on this store. A read of one
 * task costs what that task and its links cost; a list costs about ten rows
 * for each task it returns. The statements do not grow with the number of
 * projects.
 */
const BUDGETS: Record<string, { readonly statements: number; readonly rowsRead: number }> = {
  'HTTP board, largest project': { statements: 5, rowsRead: 7_000 },
  'HTTP task page': { statements: 3, rowsRead: 60 },
  'HTTP task history': { statements: 3, rowsRead: 60 },
  'HTTP change feed, 200 changes': { statements: 1, rowsRead: 250 },
  'HTTP label read, 12 tasks in the largest project': { statements: 2, rowsRead: 300 },
  'HTTP label read, a page of 200 in the largest project': { statements: 2, rowsRead: 3_500 },
  list_projects: { statements: 1, rowsRead: 20 },
  'list_tasks ready, every project': { statements: 2, rowsRead: 10_000 },
  'list_tasks, every project': { statements: 3, rowsRead: 16_000 },
  'list_tasks search, every project': { statements: 3, rowsRead: 22_000 },
  'list_tasks, largest project': { statements: 3, rowsRead: 6_000 },
  get_task: { statements: 3, rowsRead: 60 },
  get_task_history: { statements: 3, rowsRead: 60 },
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
      'list_tasks, largest project': () => read(target, 'list_tasks', { project: big.id }),
      get_task: () => read(target, 'get_task', { project: big.id, task }),
      get_task_history: () => read(target, 'get_task_history', { project: big.id, task }),
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
  });
});
