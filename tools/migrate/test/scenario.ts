/**
 * The test hub: two invented projects whose tasks go through what NoticeOS
 * did with Beads, each step as its own commit. Every id, name and text is
 * made up.
 */
import type { JsonObject } from '@ntasks/domain';
import { EXPORT_FORMAT, type BeadsExport } from '../src/beads.ts';
import { FakeHub } from './fake-hub.ts';

export const ACME_ID = 'a1111111-0000-4000-8000-000000000001';
export const BETA_ID = 'b2222222-0000-4000-8000-000000000002';

/** Minute `n` of the test day, as an ISO time. */
export function t(n: number, second = 0): string {
  const base = Date.parse('2026-03-02T09:00:00.000Z');
  return new Date(base + n * 60_000 + second * 1000).toISOString();
}

export const AWKWARD_TEXT =
  'Quotes \' and " ; semicolons; -- not a comment /* nor this */\nA second line, ünïcödé and 🧪.';

export const CARD: JsonObject = {
  valuePerMonth: 120,
  likelihood: 0.4,
  reviewMinutes: 5,
  daysToSignal: 14,
  measurability: 'cohort',
};
export const SHIPPED: JsonObject = { card: CARD, closedAt: t(40), commit: 'abc1234' };

export function acmeHub(): FakeHub {
  const hub = new FakeHub({
    database: 'acme_tasks',
    key: 'acme.example.com',
    name: 'Acme',
    id: ACME_ID,
    prefix: 'acme',
  });

  // An epic and two children, filed by an agent through NoticeOS.
  hub.commit(
    t(0),
    'noticeos',
    (c) => {
      c.create({
        id: 'acme-e1',
        title: 'Launch the shop',
        issue_type: 'epic',
        priority: 1,
        metadata: { noticeos_filed_by: 'agent-a', noticeos_filed_model: 'model-one' },
      });
    },
    { issue: 'acme-e1', event: 'created', actor: 'agent-a' },
  );
  hub.commit(t(1), 'noticeos', (c) => {
    c.create({
      id: 'acme-e1.1',
      title: 'Write the product pages',
      description: AWKWARD_TEXT,
      acceptance_criteria: 'Pages render.',
    });
    c.link('acme-e1.1', 'acme-e1', 'parent-child');
    c.label('acme-e1.1', 'content');
  });
  hub.commit(t(2), 'noticeos', (c) => {
    c.create({ id: 'acme-e1.2', title: 'Checkout breaks on retry', issue_type: 'bug', priority: 0 });
    c.link('acme-e1.2', 'acme-e1', 'parent-child');
    c.link('acme-e1.2', 'acme-e1.1', 'blocks');
  });

  // A task claimed, worked, closed and attributed, with a card frozen on close.
  hub.commit(
    t(10),
    'noticeos',
    (c) => {
      c.create({
        id: 'acme-t1',
        title: 'Add the price feed',
        metadata: {
          noticeos_filed_by: 'agent-a',
          noticeos_filed_model: 'model-one',
          noticeos_card: CARD,
          noticeos_change_class: 'feature',
          noticeos_operation_id: 'op-0001',
        },
      });
      c.label('acme-t1', 'feed');
    },
    { issue: 'acme-t1', event: 'created', actor: 'agent-a' },
  );
  hub.commit(
    t(20),
    'noticeos',
    (c) => {
      c.update('acme-t1', {
        status: 'in_progress',
        assignee: 'agent-b',
        started_at: '2026-03-02 09:20:00',
        metadata: { ...(hub.issues.get('acme-t1')!.metadata as object), noticeos_claimed_model: 'model-two' },
      });
    },
    { issue: 'acme-t1', event: 'claimed', actor: 'agent-b' },
  );
  hub.comment('acme-t1', 'k-0001', 'agent-b', 'Started on the feed.', t(25));
  hub.commit(t(30), 'noticeos', (c) => {
    c.label('acme-t1', 'backend');
    c.unlabel('acme-t1', 'feed');
  });
  hub.commit(
    t(40),
    'noticeos',
    (c) => {
      c.update('acme-t1', { status: 'closed', closed_at: '2026-03-02 09:40:00', close_reason: 'Shipped in abc1234.' });
    },
    { issue: 'acme-t1', event: 'closed', actor: 'agent-b' },
  );
  hub.commit(t(40, 1), 'noticeos', (c) => {
    c.update('acme-t1', {
      metadata: {
        ...(hub.issues.get('acme-t1')!.metadata as object),
        noticeos_closed_by: 'agent-b',
        noticeos_closed_model: 'model-two',
        noticeos_closed_at: t(40),
        noticeos_resolution: 'done',
        noticeos_card_shipped: SHIPPED,
      },
    });
  });
  // A comment in the same second as a change.
  hub.comment('acme-t1', 'k-0002', 'owner', 'Thanks!', t(40, 1));

  // A task waiting on an approval that a person then gives.
  hub.commit(t(50), 'noticeos', (c) => {
    c.create({ id: 'acme-t2', title: 'Turn on the new checkout', metadata: { noticeos_filed_by: 'agent-a' } });
  });
  hub.commit(t(51), 'noticeos', (c) => {
    c.create({
      id: 'acme-g1',
      title: 'Approve turning on the new checkout',
      issue_type: 'gate',
      await_type: 'human',
      description: 'It changes live payments.',
    });
    c.link('acme-t2', 'acme-g1', 'blocks');
  });
  hub.commit(t(60), 'noticeos', (c) => {
    c.update('acme-g1', { status: 'closed', closed_at: '2026-03-02 10:00:00', close_reason: 'Approved by the owner.' });
  });

  // A decision with choices, answered by a person.
  const choices: JsonObject = {
    question: 'Which carrier?',
    options: [
      { key: 'a', label: 'Carrier one', recommended: true },
      { key: 'b', label: 'Carrier two', detail: 'Cheaper, slower.' },
    ],
  };
  hub.commit(t(70), 'noticeos', (c) => {
    c.create({
      id: 'acme-d1',
      title: 'Choose a carrier',
      issue_type: 'decision',
      metadata: { noticeos_choices: choices },
    });
    c.label('acme-d1', 'human');
  });
  hub.commit(t(80), 'noticeos', (c) => {
    c.update('acme-d1', {
      metadata: {
        noticeos_choices: choices,
        noticeos_choice: { option: 'a', label: 'Carrier one', by: 'owner', at: t(80) },
      },
    });
    c.unlabel('acme-d1', 'human');
  });
  hub.comment('acme-d1', 'k-0003', 'owner', 'Chose (a) Carrier one', t(80));
  hub.commit(t(81), 'noticeos', (c) => {
    c.update('acme-d1', {
      status: 'closed',
      closed_at: '2026-03-02 10:21:00',
      close_reason: 'Chose (a) Carrier one',
      metadata: {
        ...(hub.issues.get('acme-d1')!.metadata as object),
        noticeos_closed_by: 'owner',
        noticeos_closed_at: t(81),
        noticeos_resolution: 'done',
      },
    });
  });

  // A duplicate, and a task closed and opened again.
  hub.commit(t(90), 'noticeos', (c) => {
    c.create({ id: 'acme-t3', title: 'Turn on the new checkout (again)' });
    c.link('acme-t3', 'acme-t2', 'discovered-from');
  });
  hub.commit(t(91), 'noticeos', (c) => {
    c.update('acme-t3', {
      status: 'closed',
      closed_at: '2026-03-02 10:31:00',
      close_reason: 'Same as acme-t2.',
      metadata: {
        noticeos_closed_by: 'agent-a',
        noticeos_closed_at: t(91),
        noticeos_resolution: 'duplicate',
        noticeos_duplicate_of: 'acme-t2',
      },
    });
  });
  hub.commit(t(100), 'noticeos', (c) => {
    c.create({
      id: 'acme-t4',
      title: 'Tidy the footer',
      defer_until: '2026-04-01 00:00:00',
      due_at: '2026-04-15 00:00:00',
    });
  });
  hub.commit(t(101), 'noticeos', (c) => {
    c.update('acme-t4', {
      status: 'closed',
      closed_at: '2026-03-02 10:41:00',
      close_reason: 'Done.',
      metadata: { noticeos_closed_by: 'agent-a', noticeos_closed_at: t(101), noticeos_resolution: 'done' },
    });
  });
  hub.commit(t(102), 'noticeos', (c) => {
    // Beads clears the close time on reopen; NoticeOS's closer stays in metadata, describing the old close.
    c.update('acme-t4', { status: 'open', closed_at: null });
  });
  // A link to a task in the other project, as NoticeOS records it.
  hub.commit(t(110), 'noticeos', (c) => {
    c.update('acme-t4', {
      metadata: {
        ...(hub.issues.get('acme-t4')!.metadata as object),
        noticeos_related_tasks: [{ projectId: BETA_ID, taskId: 'beta-x1' }],
      },
    });
  });
  return hub;
}

export function betaHub(): FakeHub {
  const hub = new FakeHub({
    database: 'beta_tasks',
    key: 'beta.example.com',
    name: 'Beta',
    id: BETA_ID,
    prefix: 'beta',
  });
  hub.commit(
    t(5),
    'beads',
    (c) => {
      c.create({ id: 'beta-x1', title: 'Index the archive' });
    },
    { issue: 'beta-x1', event: 'created' },
  );
  hub.commit(t(6), 'beads', (c) => {
    c.create({ id: 'beta-x2', title: 'Blocked by the archive', priority: 3 });
    c.link('beta-x2', 'beta-x1', 'blocks', { created_by: '' });
  });
  hub.comment('beta-x2', 'k-0100', 'agent-c', 'Waiting on beta-x1.', t(7));
  // Written but not committed yet.
  hub.uncommitted(t(120), 'beads', (c) => {
    c.update('beta-x2', { priority: 1 });
  });
  return hub;
}

export function exportOf(...hubs: readonly FakeHub[]): BeadsExport {
  return {
    format: EXPORT_FORMAT,
    exportedAt: t(200),
    doltVersion: '2.4.0',
    projects: hubs.map((hub) => hub.project()),
  };
}

export function scenario(): BeadsExport {
  return exportOf(acmeHub(), betaHub());
}
