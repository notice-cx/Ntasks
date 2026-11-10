// A person's time zone: what PATCH /api/access/me saves with their account,
// what GET /api/access/me answers, and who may set one.
import { describe, expect, it } from 'vitest';
import { Browser, call, connectAgent, createProject, meWithToken } from './client.ts';
import { standInForGitHub } from './github.ts';

standInForGitHub();

async function me(browser: Browser, method = 'GET', json?: unknown) {
  const response = await browser.fetch('/api/access/me', { method, ...(json === undefined ? {} : { json }) });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

describe("a person's time zone", () => {
  it('is null until they choose one, then saved with their account and read in every session', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    await me(browser, 'PATCH', { timeZone: null });
    expect((await me(browser)).body).toMatchObject({ kind: 'person', timeZone: null });

    expect(await me(browser, 'PATCH', { timeZone: 'America/Los_Angeles' })).toMatchObject({
      status: 200,
      body: { kind: 'person', timeZone: 'America/Los_Angeles' },
    });
    expect((await me(browser)).body).toMatchObject({ timeZone: 'America/Los_Angeles' });
    // Another browser signed in to the same account reads the same zone.
    const other = new Browser();
    await other.signInAsOwner();
    expect((await me(other)).body).toMatchObject({ timeZone: 'America/Los_Angeles' });

    expect(await me(browser, 'PATCH', { timeZone: null })).toMatchObject({ status: 200, body: { timeZone: null } });
    expect((await me(other)).body).toMatchObject({ timeZone: null });
  });

  it('refuses a name that is no time zone and any other field, and has none for an agent', async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    for (const json of [{ timeZone: 'Mars/Olympus_Mons' }, { timeZone: 42 }, { timeZone: 'UTC', name: 'x' }, []]) {
      expect((await me(browser, 'PATCH', json)).status, JSON.stringify(json)).toBe(400);
    }
    expect((await me(browser, 'DELETE')).status).toBe(405);

    const { tokens } = await connectAgent(browser, [await createProject('Time zones')]);
    const agent = await meWithToken(tokens.access_token);
    expect(await agent.json()).not.toHaveProperty('timeZone');
    const refused = await call('/api/access/me', {
      method: 'PATCH',
      body: JSON.stringify({ timeZone: 'UTC' }),
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
    });
    expect(refused.status).toBe(403);
  });
});
