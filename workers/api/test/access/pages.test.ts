import { describe, expect, it } from 'vitest';
import { PAGE_COLOURS, PAGE_FONT_FILES } from '../../src/access/page-look.ts';
import { agentAccessPage, signInPage } from '../../src/access/pages.ts';

const AGENT = {
  personName: 'Example Owner',
  client: { name: 'Example Agent', uri: 'https://agent.example.com' },
  returnsTo: 'https://agent.example.com',
  oauthQuery: 'client_id=c1',
  error: null,
};
const WORKSPACE_ID = '0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e';
const WORKSPACES = [
  { id: WORKSPACE_ID, name: 'Example', projects: [{ id: 'p-web', key: 'web', name: 'Example web app' }] },
];

describe("the Worker's pages", () => {
  it('draw with Inter from this origin, which their policy lets them load, and no colour of their own', async () => {
    const response = signInPage({ signedInAs: null, oauthQuery: null, error: null });
    const html = await response.text();
    for (const file of PAGE_FONT_FILES) expect(html).toContain(`url(${file})`);
    expect(response.headers.get('content-security-policy')).toContain("font-src 'self'");
    // The pages' colours are the design system's tokens (apps/web/test/design.test.tsx ties them to the app's).
    expect(html).not.toContain('--alert');
    const tokens = new Set<string>(Object.values(PAGE_COLOURS).flat());
    const used = html.match(/#[0-9a-f]{6}\b/giu) ?? [];
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((hex) => !tokens.has(hex.toLowerCase()))).toEqual([]);
  });

  it('show an error in words after the alert icon, never in a colour of its own', async () => {
    const html = await signInPage({ signedInAs: null, oauthQuery: null, error: 'not_invited' }).text();
    expect(html).toMatch(
      /<p class="alert" role="alert"><svg[^>]*aria-hidden="true">.*<\/svg>This GitHub account is not a member of a workspace here\. [^<]*<\/p>/su,
    );
  });

  it('offer Allow only when the agent asks for access and there is a project to give it', async () => {
    const allowing = await agentAccessPage({ ...AGENT, access: 'read', workspaces: WORKSPACES }).text();
    expect(allowing).toContain('<dt>Access</dt><dd>Read tasks</dd>');
    expect(allowing).toContain('value="allow"');
    expect(allowing).toContain(`value="${WORKSPACE_ID}/p-web"`);

    const nothingAsked = await agentAccessPage({ ...AGENT, access: null, workspaces: WORKSPACES }).text();
    expect(nothingAsked).toContain('<dt>Access</dt><dd><span class="quiet">None</span></dd>');
    expect(nothingAsked).not.toContain('value="allow"');
    expect(nothingAsked).not.toContain('name="project"');

    for (const workspaces of [[], [{ ...WORKSPACES[0]!, projects: [] }]]) {
      const noProjects = await agentAccessPage({ ...AGENT, access: 'write', workspaces }).text();
      expect(noProjects).toContain('<dt>Projects</dt><dd><span class="quiet">None yet</span></dd>');
      expect(noProjects).not.toContain('value="allow"');
      expect(noProjects).toContain('value="deny"');
    }
  });

  it("offer each workspace's projects, each naming its workspace", async () => {
    const other = { id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', name: 'Other', projects: WORKSPACES[0]!.projects };
    const html = await agentAccessPage({ ...AGENT, access: 'write', workspaces: [...WORKSPACES, other] }).text();
    const values = [...html.matchAll(/name="project" value="([^"]+)"/gu)].map((match) => match[1]);
    expect(values).toEqual([`${WORKSPACE_ID}/p-web`, `${other.id}/p-web`]);
  });
});
