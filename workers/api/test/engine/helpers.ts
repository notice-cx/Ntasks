// Shared set-up for the engine tests: a fresh project per test, a clock the
// test moves, and the actors that act in them.
import { TaskRefused, type Actor, type Project, type TaskEngine, type TaskRefusal } from '@ntasks/domain';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { createEngine, type EngineOptions } from '../../src/engine/index.ts';

export const AGENT: Actor = { name: 'agent-a', model: 'model-a' };
export const OTHER: Actor = { name: 'agent-b', model: 'model-b' };
export const OWNER: Actor = { name: 'owner' };

/** A clock that starts at a fixed time and moves only when a test moves it. */
export function clock(start = '2026-11-06T12:00:00.000Z') {
  let current = Date.parse(start);
  return {
    now: () => new Date(current).toISOString(),
    advance(minutes: number) {
      current += minutes * 60_000;
    },
  };
}

export function engine(options: EngineOptions = {}): TaskEngine {
  return createEngine(env.DB, options);
}

/** A project with a prefix no other test uses, so tests never see each other's tasks. */
export async function newProject(tasks: TaskEngine): Promise<Project> {
  const id = crypto.randomUUID();
  return tasks.createProject({ id, key: `${id.slice(0, 8)}.example.com`, name: 'Test project', prefix: `p${id.slice(0, 8)}` });
}

/** Asserts that `work` is refused with `refusal`. */
export async function expectRefusal(work: Promise<unknown>, refusal: TaskRefusal): Promise<TaskRefused> {
  const error = await work.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(TaskRefused);
  expect((error as TaskRefused).refusal).toBe(refusal);
  return error as TaskRefused;
}

/** A retry identity for `key`, with a request hash made from `request`. */
export async function retryFor(key: string, request: unknown, operation = 'write') {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request)));
  const requestHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { principal: 'principal-a', operation, key, requestHash };
}
