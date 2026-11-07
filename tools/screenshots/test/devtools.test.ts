import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DevTools, until, type ProtocolSocket } from '../src/devtools.ts';

/** A socket that records what is sent and delivers what a test hands it. */
class StandInSocket implements ProtocolSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.deliver('close');
  }

  addEventListener(type: 'message' | 'close' | 'error', listener: (event: { data: unknown }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  deliver(type: string, data?: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }
}

describe('the DevTools client', () => {
  it('answers each request with the reply that carries its id', async () => {
    const socket = new StandInSocket();
    const devtools = new DevTools(socket);
    const first = devtools.send('Page.enable');
    const second = devtools.send('Runtime.evaluate', { expression: '1' }, { sessionId: 'session-1' });
    assert.deepEqual(JSON.parse(socket.sent[1] ?? ''), {
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
      sessionId: 'session-1',
    });
    socket.deliver('message', JSON.stringify({ id: 2, result: { value: 1 } }));
    socket.deliver('message', JSON.stringify({ id: 1, error: { message: 'Not allowed' } }));
    assert.deepEqual(await second, { value: 1 });
    await assert.rejects(first, /Not allowed/);
  });

  it('fails every waiting request when the connection closes, and every later one at once', async () => {
    const socket = new StandInSocket();
    const devtools = new DevTools(socket);
    const evaluating = devtools.send('Runtime.evaluate');
    const capturing = devtools.send('Page.captureScreenshot');
    socket.deliver('close');
    await assert.rejects(evaluating, /connection to Chrome closed/);
    await assert.rejects(capturing, /connection to Chrome closed/);
    await assert.rejects(devtools.send('Page.navigate'), /connection to Chrome closed/);
    assert.equal(socket.sent.length, 2);
  });

  it('stops waiting for a request whose signal aborts, and drops its late answer', async () => {
    const socket = new StandInSocket();
    const devtools = new DevTools(socket);
    const stop = new AbortController();
    const waiting = devtools.send('Runtime.evaluate', {}, { signal: stop.signal });
    stop.abort(new Error('Timed out waiting for the page to draw.'));
    await assert.rejects(waiting, /Timed out waiting for the page to draw/);
    // The answer that arrives after the abort is dropped, and the client keeps working.
    socket.deliver('message', JSON.stringify({ id: 1, result: {} }));
    const next = devtools.send('Page.enable');
    socket.deliver('message', JSON.stringify({ id: 2, result: { ok: true } }));
    assert.deepEqual(await next, { ok: true });
  });

  it('fails waiting requests when the connection errors', async () => {
    const socket = new StandInSocket();
    const devtools = new DevTools(socket);
    const waiting = devtools.send('Runtime.evaluate');
    socket.deliver('error');
    await assert.rejects(waiting, /connection to Chrome closed/);
  });
});

describe('until', () => {
  it('passes a failed check on at once, without waiting out its time', async () => {
    const started = Date.now();
    await assert.rejects(
      until('the page to draw', () => Promise.reject(new Error('The connection to Chrome closed.')), {
        waitMs: 30_000,
      }),
      /connection to Chrome closed/,
    );
    assert.ok(Date.now() - started < 1_000);
  });

  it('counts a failed check as not yet when told to, and resolves once it holds', async () => {
    let asked = 0;
    await until(
      'the web app',
      async () => {
        asked += 1;
        if (asked < 3) throw new Error('Connection refused');
        return true;
      },
      { waitMs: 5_000, retryFailures: true },
    );
    assert.equal(asked, 3);
  });

  it('gives up on time while a check never answers, and aborts that check', async () => {
    let handed: AbortSignal | undefined;
    const started = Date.now();
    await assert.rejects(
      until(
        'the page to draw',
        (signal) => {
          handed = signal;
          return new Promise<boolean>(() => {});
        },
        { waitMs: 150 },
      ),
      /Timed out waiting for the page to draw/,
    );
    assert.ok(Date.now() - started < 1_000);
    assert.equal(handed?.aborted, true);
  });

  it('gives up after its time, naming what it waited for', async () => {
    await assert.rejects(
      until('the web app', async () => false, { waitMs: 150 }),
      /Timed out waiting for the web app/,
    );
  });
});
