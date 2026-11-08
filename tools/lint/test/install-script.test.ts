// Run by `node --test`. Runs the root install.sh against stand-in `claude`,
// `codex` and `gemini` commands in a temporary HOME, with the repository's
// skill file as the download, so no test reaches the network or a real agent.
// Each stand-in keeps its registrations in files and prints them as that
// agent's current release does (Claude Code 2, Codex CLI 0.166, Gemini CLI
// 0.66), which is what install.sh reads.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

const root = join(import.meta.dirname, '../../..');
const script = join(root, 'install.sh');
const skillSource = join(root, 'skills/ntasks/SKILL.md');
const endpoint = 'https://ntasks.example.com/api/mcp';

const STUBS: Record<string, string> = {
  claude: `
case "$1 $2" in
  "mcp get")
    [ -f "$state/claude-$3" ] || { echo "No MCP server found with name: $3" >&2; exit 1; }
    printf '%s:\\n  Scope: User config (available in all your projects)\\n  Status: ✘ Failed to connect\\n  Type: http\\n  URL: %s\\n' "$3" "$(cat "$state/claude-$3")" ;;
  "mcp add")
    shift 2
    while [ "\${1#-}" != "$1" ]; do shift 2; done
    [ ! -f "$state/claude-$1" ] || { echo "MCP server $1 already exists in user config" >&2; exit 1; }
    printf '%s' "$2" >"$state/claude-$1" ;;
  "mcp remove") rm "$state/claude-$3" ;;
esac`,
  codex: `
case "$1 $2" in
  "mcp get")
    [ -f "$state/codex-$3" ] || { echo "Error: No MCP server named '$3' found." >&2; exit 1; }
    printf '{\\n  "name": "%s",\\n  "transport": {\\n    "type": "streamable_http",\\n    "url": "%s",\\n    "bearer_token_env_var": null\\n  }\\n}\\n' "$3" "$(cat "$state/codex-$3")" ;;
  "mcp add") printf '%s' "$5" >"$state/codex-$3" ;;
esac`,
  gemini: `
case "$1 $2" in
  "mcp list")
    echo "Configured MCP servers:"
    echo
    for file in "$state"/gemini-*; do
      [ -f "$file" ] && printf '✓ %s: %s (http) - Connected\\n' "\${file##*/gemini-}" "$(cat "$file")"
    done ;;
  "mcp add")
    shift 2
    while [ "\${1#-}" != "$1" ]; do shift 2; done
    printf '%s' "$2" >"$state/gemini-$1" ;;
esac
exit 0`,
};

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Machine {
  readonly home: string;
  readonly bin: string;
}

/** A temporary HOME and a folder of stand-ins for the named agents. */
async function machine(agents: readonly string[]): Promise<Machine> {
  const dir = await mkdtemp(join(tmpdir(), 'ntasks-install-'));
  made.push(dir);
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  await mkdir(join(home, '.stub'), { recursive: true });
  await mkdir(bin);
  for (const agent of agents) {
    const path = join(bin, agent);
    const body = STUBS[agent]!;
    await writeFile(path, `#!/bin/bash\nstate="$HOME/.stub"\nprintf '${agent} %s\\n' "$*" >>"$state/calls"${body}\n`);
    await chmod(path, 0o755);
  }
  return { home, bin };
}

interface Run {
  readonly code: number | null;
  readonly output: string;
}

/** Runs install.sh in its own session, so it has no terminal to prompt on. */
async function install(at: Machine, args: readonly string[], env: Record<string, string> = {}): Promise<Run> {
  // Only these variables: none of the caller's NTASKS_ settings or agents.
  const only: Record<string, string> = {
    HOME: at.home,
    PATH: `${at.bin}:/usr/bin:/bin`,
    TMPDIR: tmpdir(),
    NTASKS_SKILL_SOURCE: skillSource,
    ...env,
  };
  const child = spawn('bash', [script, ...args], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The Worker's generated types, included here for the lint fixtures,
    // declare AUTH_SECRET in every process environment.
    env: only as NodeJS.ProcessEnv,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, output };
}

async function registered(at: Machine, agent: string): Promise<string | null> {
  return readFile(join(at.home, '.stub', `${agent}-ntasks`), 'utf8').catch(() => null);
}

async function calls(at: Machine): Promise<string[]> {
  const text = await readFile(join(at.home, '.stub', 'calls'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean);
}

const writes = (lines: readonly string[]) => lines.filter((line) => / mcp (add|remove) /u.test(line));

test('sets up each chosen agent, and a second run changes nothing', async () => {
  const at = await machine(['claude', 'codex', 'gemini']);
  const first = await install(at, ['--url', 'ntasks.example.com/', '--agents', 'claude,codex,gemini', '--yes']);
  assert.equal(first.code, 0, first.output);

  assert.deepEqual(writes(await calls(at)), [
    `claude mcp add --transport http --scope user ntasks ${endpoint}`,
    `codex mcp add ntasks --url ${endpoint}`,
    `gemini mcp add --transport http --scope user ntasks ${endpoint}`,
  ]);
  for (const agent of ['claude', 'codex', 'gemini']) assert.equal(await registered(at, agent), endpoint);

  const skill = await readFile(skillSource, 'utf8');
  const claudeSkill = join(at.home, '.claude/skills/ntasks/SKILL.md');
  const sharedSkill = join(at.home, '.agents/skills/ntasks/SKILL.md');
  assert.equal(await readFile(claudeSkill, 'utf8'), skill);
  assert.equal(await readFile(sharedSkill, 'utf8'), skill);
  const before = [(await stat(claudeSkill)).mtimeMs, (await stat(sharedSkill)).mtimeMs];

  const callsBefore = (await calls(at)).length;
  const second = await install(at, ['--url', 'https://ntasks.example.com', '--agents', 'claude,codex,gemini', '--yes']);
  assert.equal(second.code, 0, second.output);
  assert.deepEqual(writes((await calls(at)).slice(callsBefore)), []);
  assert.deepEqual([(await stat(claudeSkill)).mtimeMs, (await stat(sharedSkill)).mtimeMs], before);
});

test('without --yes and with no terminal, it changes nothing', async () => {
  const at = await machine(['claude', 'codex']);
  const run = await install(at, [], { NTASKS_URL: 'https://ntasks.example.com', NTASKS_AGENTS: 'claude' });
  assert.notEqual(run.code, 0);
  assert.deepEqual(writes(await calls(at)), []);
  assert.equal(await readFile(join(at.home, '.claude/skills/ntasks/SKILL.md'), 'utf8').catch(() => null), null);
});

test('replaces a registration at another address only with --yes', async () => {
  const at = await machine(['claude']);
  const old = 'https://old.example.com/api/mcp';
  await writeFile(join(at.home, '.stub', 'claude-ntasks'), old);

  const refused = await install(at, ['--url', 'https://ntasks.example.com', '--agents', 'claude']);
  assert.notEqual(refused.code, 0);
  assert.equal(await registered(at, 'claude'), old);
  assert.deepEqual(writes(await calls(at)), []);

  const replaced = await install(at, ['--url', 'https://ntasks.example.com', '--agents', 'claude', '--yes']);
  assert.equal(replaced.code, 0, replaced.output);
  assert.equal(await registered(at, 'claude'), endpoint);
  assert.deepEqual(writes(await calls(at)), [
    'claude mcp remove ntasks --scope user',
    `claude mcp add --transport http --scope user ntasks ${endpoint}`,
  ]);
});

test('fails when it cannot write the skill', async () => {
  const at = await machine(['claude']);
  // A file where the skills folder goes stops the write even for root.
  await mkdir(join(at.home, '.claude'));
  await writeFile(join(at.home, '.claude/skills'), '');
  const run = await install(at, ['--url', 'https://ntasks.example.com', '--agents', 'claude', '--yes']);
  assert.notEqual(run.code, 0, run.output);
});

test('accepts http only for localhost, and only installed agents', async () => {
  const at = await machine(['claude']);
  for (const args of [
    ['--url', 'http://ntasks.example.com', '--agents', 'claude'],
    ['--url', 'https://ntasks.example.com', '--agents', 'codex'],
  ]) {
    const run = await install(at, [...args, '--yes']);
    assert.notEqual(run.code, 0, args.join(' '));
  }
  assert.deepEqual(await calls(at), []);

  const local = await install(at, ['--url', 'http://localhost:8787', '--agents', 'claude', '--yes']);
  assert.equal(local.code, 0, local.output);
  assert.equal(await registered(at, 'claude'), 'http://localhost:8787/api/mcp');
});
