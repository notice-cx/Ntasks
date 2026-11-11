// An owner's settings of a project over HTTP (PATCH /api/tasks/projects):
// its name, whether it takes new tasks, and its website, whose icon the
// Worker reads and serves (GET /api/tasks/projects/:id/icon). Every website
// here is invented, and the fetch the Worker reads it with answers in its place.
import type { Project, TaskEngine } from '@ntasks/domain';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCOPES, type Principal } from '../../src/auth.ts';
import { clock, newProject, OWNER } from '../engine/helpers.ts';
import { api, get, ORIGIN, read, refusal, send, WRITER, type TestApi } from './helpers.ts';

const time = clock('2026-11-10T12:00:00.000Z');
const OWNER_SENDER: Principal = Object.freeze({
  id: 'principal-owner',
  name: 'owner',
  scopes: [SCOPES.read, SCOPES.write, SCOPES.manage],
  projects: 'all',
});
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);

let owner: TestApi;
let writer: TestApi;
let engine: TaskEngine;
/** What each invented website answers, by address; anything else is a 404. */
let sites: Record<string, () => Response>;
let asked: string[];

beforeAll(() => {
  owner = api({ principal: OWNER_SENDER, now: time.now });
  engine = owner.engine;
  writer = api({ principal: WRITER, engine, now: time.now });
});

beforeEach(() => {
  sites = {};
  asked = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    asked.push(url);
    return sites[url]?.() ?? new Response('Not Found', { status: 404 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Listed = { projects: Record<string, unknown>[] };
const listed = async (project: Project) =>
  ((await get(writer, '/api/tasks/projects')).body as Listed).projects.find((row) => row.projectId === project.id);
const patch = (target: TestApi, body: Record<string, unknown>) => send(target, 'PATCH', '/api/tasks/projects', body);

describe('renaming a project', () => {
  it('changes the name people see and keeps its key and prefix, for an owner only', async () => {
    const project = await newProject(engine);
    expect((await patch(writer, { projectId: project.id, displayName: 'Shop' })).status).toBe(403);
    expect(await patch(owner, { projectId: project.id, displayName: '  Shop  ' })).toMatchObject({
      status: 200,
      body: { project: { displayName: 'Shop', logicalKey: project.key, prefix: project.prefix } },
    });
    expect(await listed(project)).toMatchObject({ displayName: 'Shop' });
  });

  it('refuses an empty name under its field, changing nothing', async () => {
    const project = await newProject(engine);
    expect(await patch(owner, { projectId: project.id, displayName: ' ', disabled: true })).toMatchObject({
      status: 400,
      body: { error: 'invalid_request', field: 'displayName' },
    });
    expect(await listed(project)).toMatchObject({ displayName: project.name, disabled: false });
  });
});

describe('a disabled project', () => {
  it('refuses new tasks over HTTP and MCP, keeps its tasks readable, and takes them again once enabled', async () => {
    const project = await newProject(engine);
    const { task } = await engine.createTask(project.id, { title: 'Filed before' }, OWNER);
    expect(await patch(owner, { projectId: project.id, disabled: true })).toMatchObject({
      status: 200,
      body: { project: { disabled: true } },
    });
    expect(await listed(project)).toMatchObject({ disabled: true });
    const { projects } = await read<{ projects: Record<string, unknown>[] }>(writer, 'list_projects');
    expect(projects.find((row) => row.projectId === project.id)).toMatchObject({ disabled: true });

    const filed = await send(writer, 'POST', '/api/tasks', { projectId: project.id, title: 'Filed after' });
    expect(filed).toMatchObject({ status: 409 });
    expect(filed.body.detail).toBe(
      `${project.name} is disabled, so it takes no new tasks. An owner can enable it in Settings.`,
    );
    expect(await refusal(writer, 'create_task', { project: project.id, title: 'Filed after' })).toContain(
      'is disabled, so it takes no new tasks',
    );
    expect((await get(writer, `/api/tasks/${task.id}?project=${project.id}`)).status).toBe(200);
    expect(await read(writer, 'get_task', { project: project.id, task: task.id })).toMatchObject({
      task: { id: task.id },
    });

    await patch(owner, { projectId: project.id, disabled: false });
    expect((await send(writer, 'POST', '/api/tasks', { projectId: project.id, title: 'Filed again' })).status).toBe(
      200,
    );
  });
});

describe('a project’s website', () => {
  it('is read for its icon, which the project list points to and the icon route serves', async () => {
    const project = await newProject(engine);
    sites['https://shop.example.com/'] = () =>
      new Response('<head><link rel="apple-touch-icon" href="/touch.png"></head>', {
        headers: { 'content-type': 'text/html' },
      });
    sites['https://shop.example.com/touch.png'] = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });

    const saved = await patch(owner, { projectId: project.id, websiteUrl: 'shop.example.com' });
    expect(saved).toMatchObject({ status: 200, body: { project: { websiteUrl: 'https://shop.example.com/' } } });
    const icon = (saved.body.project as { icon: string }).icon;
    expect(icon).toMatch(new RegExp(`^/api/tasks/projects/${project.id}/icon\\?v=\\d+$`, 'u'));
    expect(await listed(project)).toMatchObject({ websiteUrl: 'https://shop.example.com/', icon });

    const served = await writer.fetch(new Request(`${ORIGIN}${icon}`));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    // Another icon would have another address, so one without the current version is never kept.
    const unversioned = await writer.fetch(new Request(`${ORIGIN}/api/tasks/projects/${project.id}/icon`));
    expect(unversioned.headers.get('cache-control')).toBe('private, no-cache');

    // A website with no icon replaces the icon with none, and clearing the website clears both.
    const moved = await patch(owner, { projectId: project.id, websiteUrl: 'https://new.example.com' });
    expect(moved.body.project).toMatchObject({ websiteUrl: 'https://new.example.com/', icon: null });
    expect((await writer.fetch(new Request(`${ORIGIN}/api/tasks/projects/${project.id}/icon`))).status).toBe(404);
    expect((await patch(owner, { projectId: project.id, websiteUrl: null })).body.project).toMatchObject({
      websiteUrl: null,
      icon: null,
    });
    expect(asked.every((url) => new URL(url).hostname.endsWith('.example.com'))).toBe(true);
  });

  it('refuses an address that is not a public web page under its field, reading nothing', async () => {
    const project = await newProject(engine);
    for (const websiteUrl of ['ftp://example.com', 'http://localhost:8787', 42]) {
      expect(await patch(owner, { projectId: project.id, websiteUrl })).toMatchObject({
        status: 400,
        body: { field: 'websiteUrl' },
      });
    }
    expect(asked).toEqual([]);
    expect(await listed(project)).toMatchObject({ websiteUrl: null, icon: null });
  });
});
