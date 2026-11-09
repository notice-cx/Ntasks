import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LiveTask } from '@/api/types';
import { Avatar, type AvatarSize } from '@/components/ui/avatar';
import { BLOSSOM_PATH, BLOSSOM_VIEWBOX, CLAUDE_VIEWBOX } from '@/components/ui/brand-marks';
import { PriorityMark, StatusMark, TypeMark, WorkspaceIcon } from '@/components/ui/symbols';
import {
  avatarFace,
  initials,
  priorityBars,
  priorityLabel,
  statusMarkFor,
  typeLabel,
  typeMarkFor,
  workspaceMark,
} from '@/lib/symbols';
import { IDENTITY_HUES } from '@/lib/design-tokens';

function task(fields: Partial<LiveTask>): LiveTask {
  return {
    id: 'web-a1',
    title: 'A task',
    status: 'open',
    priority: 2,
    issueType: 'task',
    assignee: null,
    updatedAt: '2026-11-01T00:00:00Z',
    closedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    parent: null,
    deferUntil: null,
    description: '',
    acceptance: '',
    labels: [],
    ready: true,
    dependencies: [],
    comments: 0,
    metadata: null,
    startedAt: null,
    closeReason: null,
    awaitType: null,
    ...fields,
  };
}

const blocks = (id: string, status: string | null) => ({ id, type: 'blocks', title: null, status });

describe('the status mark a task gets', () => {
  it('follows the stored status for open, in progress, parked and closed work', () => {
    expect(statusMarkFor(task({}))).toBe('open');
    expect(statusMarkFor(task({ status: 'in_progress' }))).toBe('in-progress');
    expect(statusMarkFor(task({ status: 'deferred' }))).toBe('parked');
    expect(statusMarkFor(task({ status: 'closed', closedAt: '2026-11-02T00:00:00Z' }))).toBe('done');
  });

  it('is Blocked when stored so, or when an open task waits on a task that is not closed', () => {
    expect(statusMarkFor(task({ status: 'blocked' }))).toBe('blocked');
    expect(statusMarkFor(task({ ready: false, dependencies: [blocks('web-b2', 'open')] }))).toBe('blocked');
    expect(statusMarkFor(task({ ready: false, dependencies: [blocks('web-b2', null)] }))).toBe('blocked');
    // The board's newer read of the other task wins over the link's own.
    expect(
      statusMarkFor(task({ dependencies: [blocks('web-b2', 'closed')] }), new Map([['web-b2', 'in_progress']])),
    ).toBe('blocked');
    expect(statusMarkFor(task({ dependencies: [blocks('web-b2', 'closed')] }))).toBe('open');
    // Only a blocking link holds a task back.
    expect(
      statusMarkFor(task({ dependencies: [{ id: 'web-b2', type: 'related', title: null, status: 'open' }] })),
    ).toBe('open');
  });

  it('is Waiting for you for an approval or a ready task labelled human', () => {
    expect(statusMarkFor(task({ issueType: 'gate', awaitType: 'human', ready: false }))).toBe('waiting');
    expect(statusMarkFor(task({ labels: ['human'] }))).toBe('waiting');
  });

  it('is Blocked, not Waiting for you, for a human task still held back by another task', () => {
    expect(statusMarkFor(task({ labels: ['human'], ready: false, dependencies: [blocks('web-b2', 'open')] }))).toBe(
      'blocked',
    );
  });

  it('leaves a parked or closed task out of Waiting for you', () => {
    expect(statusMarkFor(task({ labels: ['human'], status: 'deferred' }))).toBe('parked');
    expect(statusMarkFor(task({ issueType: 'gate', awaitType: 'human', status: 'closed' }))).toBe('done');
  });

  it('shows a status this build does not know as Open', () => {
    expect(statusMarkFor(task({ status: 'review' }))).toBe('open');
  });

  it('names each mark for a screen reader, or hides it when words beside it say it', () => {
    render(<StatusMark status="waiting" />);
    expect(screen.getByRole('img', { name: 'Waiting for you' })).toBeTruthy();
    const { container } = render(<StatusMark status="blocked" label={null} />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the priority mark', () => {
  it('words 0 to 4 as Top to Lowest, and clamps anything outside', () => {
    expect([0, 1, 2, 3, 4].map(priorityLabel)).toEqual(['Top', 'High', 'Normal', 'Low', 'Lowest']);
    expect(priorityLabel(-1)).toBe('Top');
    expect(priorityLabel(9)).toBe('Lowest');
  });

  it('fills three bars at High, two at Normal and one at Low', () => {
    expect([0, 1, 2, 3, 4].map(priorityBars)).toEqual([0, 3, 2, 1, 0]);
  });

  it('is named with its priority', () => {
    render(<PriorityMark priority={0} />);
    expect(screen.getByRole('img', { name: 'Top priority' })).toBeTruthy();
  });
});

describe('the type mark', () => {
  it('shows a gate a person answers as an Approval, and any other gate as a Gate', () => {
    expect(typeMarkFor('gate', 'human')).toBe('approval');
    expect(typeMarkFor('gate', null)).toBe('approval');
    expect(typeMarkFor('gate', 'timer')).toBe('gate');
    expect(typeLabel('gate', 'human')).toBe('Approval');
  });

  it('keeps a type this build does not know as its own word', () => {
    expect(typeMarkFor('spike')).toBe('other');
    expect(typeLabel('spike')).toBe('Spike');
    render(<TypeMark type="bug" />);
    expect(screen.getByRole('img', { name: 'Bug' })).toBeTruthy();
  });
});

describe('who an avatar shows', () => {
  it('gives Claude and Codex their marks when the actor is an agent, by its name or the model it named', () => {
    // The actors the API records: an agent, a service acting for an agent, and an agent that named its model.
    expect(avatarFace({ name: 'agent:claude' }).kind).toBe('claude');
    expect(avatarFace({ name: 'service:noticeos/claude-code' }).kind).toBe('claude');
    expect(avatarFace({ name: 'agent-one', model: 'claude-opus-5-5' }).kind).toBe('claude');
    expect(avatarFace({ name: 'agent:codex' }).kind).toBe('codex');
    expect(avatarFace({ name: 'service:noticeos/codex' }).kind).toBe('codex');
    expect(avatarFace({ name: 'agent-two', model: 'gpt-5-codex' }).kind).toBe('codex');
    expect(avatarFace({ name: 'Claude', agent: true }).kind).toBe('claude');
  });

  it('shows a person as a person, whatever their name says', () => {
    expect(avatarFace({ name: 'Claude Monet' })).toEqual({ kind: 'person', initials: 'CM' });
    expect(avatarFace({ name: 'Codex Reader' })).toEqual({ kind: 'person', initials: 'CR' });
    expect(avatarFace({ name: 'person:agent:claude' })).toEqual({ kind: 'person', initials: 'AC' });
  });

  it('gives any other agent the plain agent mark', () => {
    expect(avatarFace({ name: 'Build bot', agent: true }).kind).toBe('agent');
    expect(avatarFace({ name: 'agent:build-bot' }).kind).toBe('agent');
    expect(avatarFace({ name: 'service:noticeos' }).kind).toBe('agent');
    expect(avatarFace({ name: 'agent-three', model: 'example-model-1' }).kind).toBe('agent');
  });

  it('shows a person by up to two initials', () => {
    expect(avatarFace({ name: 'Example Owner' })).toEqual({ kind: 'person', initials: 'EO' });
    expect(initials('Ada Byron King')).toBe('AK');
    expect(initials('owner@example.com')).toBe('O');
    expect(initials('  ')).toBe('?');
  });
});

/** The drawn bounds of a path written in absolute M, L, H, V, C and Z commands, sampling each curve. */
function absolutePathBounds(path: string) {
  expect(path, 'the bounds below read absolute commands only').not.toMatch(/[a-z]/);
  const xs: number[] = [];
  const ys: number[] = [];
  let at = [0, 0];
  const visit = (x: number, y: number) => {
    xs.push(x);
    ys.push(y);
    at = [x, y];
  };
  for (const [, command, args] of path.matchAll(/([MLCHVZ])([^MLCHVZ]*)/g)) {
    const n = (args ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (command === 'H') n.forEach((x) => visit(x, at[1] ?? 0));
    else if (command === 'V') n.forEach((y) => visit(at[0] ?? 0, y));
    else if (command === 'C') {
      for (let i = 0; i + 5 < n.length; i += 6) {
        const [x0, y0] = at as [number, number];
        const [x1, y1, x2, y2, x3, y3] = n.slice(i, i + 6) as [number, number, number, number, number, number];
        for (let step = 1; step <= 64; step += 1) {
          const t = step / 64;
          const u = 1 - t;
          xs.push(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3);
          ys.push(u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
        }
        at = [x3, y3];
      }
    } else for (let i = 0; i + 1 < n.length; i += 2) visit(n[i] ?? 0, n[i + 1] ?? 0);
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe("Codex's mark beside Claude's", () => {
  it('is drawn in a box no larger than Claude’s, at every avatar size', () => {
    for (const size of [18, 20, 28, 40] satisfies AvatarSize[]) {
      const { container, unmount } = render(
        <>
          <Avatar name="Claude" agent size={size} />
          <Avatar name="Codex" agent size={size} />
        </>,
      );
      const claude = container.querySelector('[data-brand-mark="claude"]');
      const codex = container.querySelector('[data-brand-mark="codex"]');
      expect(Number(codex?.getAttribute('width'))).toBeLessThanOrEqual(Number(claude?.getAttribute('width')));
      expect(Number(codex?.getAttribute('height'))).toBeLessThanOrEqual(Number(claude?.getAttribute('height')));
      unmount();
    }
  });

  it("keeps the Blossom inside its box, so its drawing is never larger than Claude's, which fills its own", () => {
    const [x, y, width, height] = BLOSSOM_VIEWBOX.split(' ').map(Number) as [number, number, number, number];
    const bounds = absolutePathBounds(BLOSSOM_PATH);
    expect(bounds.minX).toBeGreaterThanOrEqual(x);
    expect(bounds.minY).toBeGreaterThanOrEqual(y);
    expect(bounds.maxX).toBeLessThanOrEqual(x + width);
    expect(bounds.maxY).toBeLessThanOrEqual(y + height);
    expect(CLAUDE_VIEWBOX).toBe('0 0 24 24');
  });
});

describe('a workspace icon', () => {
  const ONE = '0d1f3c6a-7b2e-4c59-8a10-3e5f7a9b1c20';
  const TWO = '2f7e5a91-c4b3-4e06-9d28-71a3b5c0e6f4';

  /** The letter an icon shows, and the colours of its fill and its letter. */
  function drawn(workspaceId: string, name: string) {
    const { container, unmount } = render(<WorkspaceIcon workspaceId={workspaceId} name={name} />);
    const icon = container.querySelector<HTMLElement>('[data-workspace-icon]');
    const seen = { letter: icon?.textContent, colours: [icon?.style.backgroundColor, icon?.style.color] };
    unmount();
    return seen;
  }

  it("shows each workspace's first letter, uppercase, and keeps its colour through a rename", () => {
    const before = drawn(ONE, 'example');
    expect(before.letter).toBe('E');
    expect(drawn(TWO, '  labs').letter).toBe('L');
    const renamed = drawn(ONE, 'Acme');
    expect(renamed.letter).toBe('A');
    expect(renamed.colours).toEqual(before.colours);
  });

  it('colours workspaces by their ids, so different ids get different hues, over the whole identity palette', () => {
    const [fill, ink] = drawn(ONE, 'Example').colours;
    const other = drawn(TWO, 'Example').colours;
    expect(other[0]).not.toBe(fill);
    expect(other[1]).not.toBe(ink);
    const ids = Array.from({ length: 24 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
    expect(new Set(ids.map((id) => workspaceMark(id, 'Example').hue))).toEqual(new Set(IDENTITY_HUES));
  });
});
