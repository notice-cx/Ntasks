// The agent approval page for a person in more workspaces than one request
// may read: each request reaches at most APPROVAL_WORKSPACES task stores, and
// the person chooses which workspaces' projects to list.
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { APPROVAL_WORKSPACES, projectChoice } from '../../src/access/pages.ts';
import type { TaskStore } from '../../src/store/index.ts';
import { store } from '../store.ts';
import {
  addMember,
  Browser,
  locationOf,
  McpClient,
  meWithToken,
  OWNER_GITHUB_ID,
  REDIRECT_URI,
  userIdOf,
} from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

interface Space {
  readonly id: string;
  readonly name: string;
  readonly project: string;
}

/** The Worker's bindings, with each task store a request reaches recorded in `reached`. */
function countingStores(): { bindings: Env; reached: string[] } {
  const reached: string[] = [];
  const stores = env.TASK_STORE;
  const counting = {
    getByName(name: string) {
      reached.push(name);
      return stores.getByName(name);
    },
  };
  return { bindings: { ...env, TASK_STORE: counting } as unknown as Env, reached };
}

/** A workspace the person is a member of, holding one project. */
async function memberOf(userId: string, index: number): Promise<Space> {
  const id = crypto.randomUUID();
  const name = `Workspace ${index}`;
  await addMember({ id, name }, userId, 'member');
  const project = crypto.randomUUID();
  await runInDurableObject(store(id), async (instance: TaskStore) => {
    await instance.tasks.createProject({
      id: project,
      key: `w${index}.example.com`,
      name: `Project ${index}`,
      prefix: `w${index}`,
    });
  });
  return { id, name, project };
}

/** The `name` checkboxes' values on a page, in order, with whether each is ticked. */
function boxes(html: string, name: string): { value: string; checked: boolean }[] {
  return [...html.matchAll(new RegExp(`name="${name}" value="([^"]+)"( checked)?`, 'gu'))].map((match) => ({
    value: match[1] ?? '',
    checked: match[2] !== undefined,
  }));
}

describe('the agent approval page for a person in many workspaces', () => {
  it('reads at most the bound of task stores per request, lists the workspaces chosen, and grants in them', async () => {
    const { bindings, reached } = countingStores();
    const browser = new Browser({ joinTestWorkspace: false, bindings });
    const client = new McpClient();
    await client.register('Example Agent');
    const { landing, verifier } = await client.authorize(browser, 'tasks:read tasks:write offline_access');
    const afterSignIn = await browser.signInWithGitHub(OWNER_GITHUB_ID, landing.search.slice(1));
    const userId = (await userIdOf(OWNER_GITHUB_ID)) ?? '';
    const spaces: Space[] = [];
    for (let index = 0; index < APPROVAL_WORKSPACES + 2; index += 1) spaces.push(await memberOf(userId, index));
    const oauthQuery = afterSignIn.search.slice(1);

    reached.length = 0;
    const first = await (await browser.fetch(`/agent-access?${oauthQuery}`)).text();
    expect(reached.length).toBeLessThanOrEqual(APPROVAL_WORKSPACES);
    const listed = boxes(first, 'project').map(({ value }) => value);
    expect(listed).toHaveLength(reached.length);
    // Every workspace is offered in the chooser, and the listed ones are ticked.
    const chooser = boxes(first, 'workspace');
    expect(chooser.map(({ value }) => value).sort()).toEqual(spaces.map(({ id }) => id).sort());
    expect(chooser.filter(({ checked }) => checked)).toHaveLength(listed.length);

    const last = spaces.at(-1)!;
    const kept = projectChoice(spaces[0]!.id, spaces[0]!.project);
    reached.length = 0;
    const shown = await (
      await browser.fetch('/agent-access', {
        form: { oauth_query: oauthQuery, decision: 'show', workspace: [spaces[0]!.id, last.id], project: kept },
      })
    ).text();
    expect(reached).toHaveLength(2);
    expect(boxes(shown, 'project')).toEqual([
      { value: kept, checked: true },
      { value: projectChoice(last.id, last.project), checked: false },
    ]);

    reached.length = 0;
    const tooMany = await (
      await browser.fetch('/agent-access', {
        form: {
          oauth_query: oauthQuery,
          decision: 'allow',
          project: spaces.map(({ id, project }) => projectChoice(id, project)),
        },
      })
    ).text();
    expect(reached.length).toBeLessThanOrEqual(APPROVAL_WORKSPACES);
    expect(tooMany).toContain('role="alert"');

    reached.length = 0;
    const approved = await browser.fetch('/agent-access', {
      form: { oauth_query: oauthQuery, decision: 'allow', project: projectChoice(last.id, last.project) },
    });
    expect(reached).toHaveLength(1);
    const back = locationOf(approved);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    const tokens = await client.exchange(back.searchParams.get('code') ?? '', verifier);
    expect(await (await meWithToken(tokens.access_token)).json()).toMatchObject({
      projects: [{ workspaceId: last.id, projectId: last.project, access: 'write' }],
    });
  });

  it('reads no task store to deny', async () => {
    const { bindings, reached } = countingStores();
    const browser = new Browser({ bindings });
    const client = new McpClient();
    await client.register('Example Agent');
    const { landing } = await client.authorize(browser, 'tasks:read offline_access');
    const afterSignIn = await browser.signInWithGitHub(OWNER_GITHUB_ID, landing.search.slice(1));

    reached.length = 0;
    const denied = await browser.fetch('/agent-access', {
      form: { oauth_query: afterSignIn.search.slice(1), decision: 'deny' },
    });
    expect(reached).toEqual([]);
    expect(locationOf(denied).searchParams.get('error')).toBe('access_denied');
  });
});
