import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const worker = exports.default;

describe('GET /healthz', () => {
  it('answers that the Worker is running', async () => {
    const response = await worker.fetch('https://ntasks.test/healthz');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/u);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers HEAD with the same status and no body', async () => {
    const response = await worker.fetch('https://ntasks.test/healthz', { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('refuses other methods and names the allowed ones', async () => {
    const response = await worker.fetch('https://ntasks.test/healthz', { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(await response.json()).toEqual({ error: 'method_not_allowed' });
  });
});

describe('a path the Worker does not serve', () => {
  it('answers 404 as JSON', async () => {
    const response = await worker.fetch('https://ntasks.test/api/no-such-route');

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});
