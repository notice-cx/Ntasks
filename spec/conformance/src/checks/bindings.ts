/** The checks of the bindings' own rules: the MCP tool profile and the HTTP binding. */
import { NotOffered } from '../api.ts';
import { answered, expect, refused, same, snapshot, unchanged, type Check } from '../check.ts';
import { file } from './steps.ts';

export const bindings: readonly Check[] = [
  {
    id: 'mcp-1-held-tasks-lead-the-instructions',
    rule: 'MCP-1',
    level: 'live',
    title: "The held tasks come before any longer text, within the first 4,096 characters of the server's instructions",
    async run(context) {
      if (context.binding !== 'mcp') throw new NotOffered(context.binding, 'serve MCP instructions');
      const id = await file(context);
      answered(await context.setup().claim(id), `claiming ${id}`);
      const told = answered(await context.api().connect(), 'connecting').instructions;
      const at = told.indexOf(id);
      expect(at >= 0, `the instructions leave out ${id}, which the agent holds`);
      expect(at < 4096, `${id} first appears at character ${at} of the instructions, past the first 4,096`);
    },
  },
  {
    id: 'mcp-2-keyless-retry-answered-once',
    rule: 'MCP-2',
    level: 'core',
    strength: 'should',
    title: 'A write sent again without an idempotency key, with nothing changed between, is answered once',
    async run(context) {
      if (context.binding !== 'mcp') throw new NotOffered(context.binding, 'key a write by its arguments');
      const api = context.api();
      const id = await file(context);
      answered(await api.comment(id, 'Sent once, then again.'), 'commenting');
      answered(await api.comment(id, 'Sent once, then again.'), 'commenting again');
      same(answered(await api.read(id), 'reading').comments.length, 1, `comments on ${id}`);
    },
  },
  {
    id: 'mcp-3-refusal-is-an-error-result',
    rule: 'MCP-3',
    level: 'core',
    title: 'A refused call answers a tool result marked as an error, and nothing of it is stored',
    async run(context) {
      if (context.binding !== 'mcp') throw new NotOffered(context.binding, 'answer an MCP tool result');
      const id = await file(context);
      answered(await context.setup().close(id, { reason: 'Dropped', resolution: 'wont-do' }), 'closing');
      const before = await snapshot(context.api(), id);
      const refusal = refused(await context.api().claim(id), `claiming the closed task ${id}`);
      expect(refusal.wellFormed, `the refusal is not a tool result marked as an error: ${refusal.text}`);
      await unchanged(context.api(), id, before, 'the refused claim');
    },
  },
  {
    id: 'http-1-refusal-carries-an-error-code',
    rule: 'HTTP-1',
    level: 'core',
    title: 'A refused request changes nothing, and its body carries an error code',
    async run(context) {
      if (context.binding !== 'http') throw new NotOffered(context.binding, 'answer an HTTP status');
      const id = await file(context);
      answered(await context.setup().close(id, { reason: 'Dropped', resolution: 'wont-do' }), 'closing');
      const before = await snapshot(context.api(), id);
      const refusal = refused(await context.api().claim(id), `claiming the closed task ${id}`);
      expect(refusal.wellFormed, `the refusal's body carries no error code: ${refusal.text}`);
      expect((refusal.status ?? 0) >= 400, `the refusal answered status ${refusal.status}`);
      await unchanged(context.api(), id, before, 'the refused claim');
    },
  },
];
