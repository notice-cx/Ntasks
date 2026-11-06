// What a sender's project grants allow: the owner reaches every project, and
// any other sender only the projects it was granted, where a read grant does
// not allow changes.
import { describe, expect, it } from 'vitest';
import { mayReach, reachable, SCOPES, type Principal } from '../src/auth.ts';

const sender = (projects: Principal['projects']): Principal => ({
  id: 'p',
  name: 'agent',
  scopes: [SCOPES.read, SCOPES.write],
  projects,
});

describe('mayReach', () => {
  it('lets the owner read and change every project', () => {
    expect([mayReach(sender('all'), 'any'), mayReach(sender('all'), 'any', 'write')]).toEqual([true, true]);
  });

  it('lets a read grant read but not change, and a write grant do both', () => {
    const granted = sender(
      new Map([
        ['a', 'read'],
        ['b', 'write'],
      ]),
    );
    expect([mayReach(granted, 'a'), mayReach(granted, 'a', 'write')]).toEqual([true, false]);
    expect([mayReach(granted, 'b'), mayReach(granted, 'b', 'write')]).toEqual([true, true]);
    expect([mayReach(granted, 'c'), mayReach(granted, 'c', 'write')]).toEqual([false, false]);
  });

  it('keeps the reachable projects in their order', () => {
    const projects = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    expect(
      reachable(
        sender(
          new Map([
            ['b', 'read'],
            ['c', 'write'],
          ]),
        ),
        projects,
      ),
    ).toEqual([{ id: 'c' }, { id: 'b' }]);
    expect(reachable(sender('all'), projects)).toEqual(projects);
  });
});
