/**
 * Runs the checks against a target: each check once on every binding the
 * server offers, one after another, so no check sees another's writes in
 * flight. A check passes when it passed on at least one binding and failed
 * on none.
 */
import { randomBytes } from 'node:crypto';
import { MissingSender, NotOffered, type Api, type Role } from './api.ts';
import { CheckFailed, sectionOf, type Check, type Context } from './check.ts';
import { checks as allChecks } from './checks/index.ts';
import { httpApi } from './http.ts';
import { mcpApi } from './mcp.ts';
import { BINDINGS, LEVELS, type BindingName, type Level, type Target } from './target.ts';

/** `not-run`: the binding offers the call, but the target names no sender the check needs for it. */
export type BindingStatus = 'passed' | 'failed' | 'not-offered' | 'not-run';

export interface BindingResult {
  readonly binding: BindingName;
  readonly status: BindingStatus;
  /** Why it failed, or what the binding does not offer. */
  readonly detail?: string;
  /** The requests the check sent, for a failure. */
  readonly trace?: readonly string[];
}

export type CheckStatus =
  /** Passed on each binding that offers what it needs. */
  | 'passed'
  | 'failed'
  /** A SHOULD rule the server does not keep. */
  | 'warned'
  /** The target lacks a sender, a project or a binding the check needs. */
  | 'not-run'
  /** Failed as a gap the target lists, with its reason. */
  | 'known-gap'
  /** Passed, though the target lists it as a gap: the list is out of date. */
  | 'gap-closed';

export interface CheckResult {
  readonly id: string;
  readonly rule: string;
  readonly section: string;
  readonly level: Level;
  readonly title: string;
  readonly status: CheckStatus;
  readonly bindings: readonly BindingResult[];
  readonly detail?: string;
}

export interface Report {
  readonly target: string;
  readonly levels: readonly {
    readonly level: Level;
    readonly claimed: boolean;
    /**
     * `incomplete`: some of its checks did not run, or `--only` left them out.
     * `known-gaps`: every check that ran passed, apart from listed gaps.
     */
    readonly status: 'passed' | 'known-gaps' | 'failed' | 'incomplete' | 'not-claimed';
  }[];
  readonly results: readonly CheckResult[];
  /** Whether `only` left some checks of the claimed levels out, so no level's verdict is complete. */
  readonly filtered: boolean;
  /** Whether every check of every claimed level passed or is a listed gap. */
  readonly passed: boolean;
}

export interface SuiteOptions {
  /** Only checks whose id or rule is listed. */
  readonly only?: readonly string[];
  /** Only these bindings, of those the target offers. */
  readonly bindings?: readonly BindingName[];
  /**
   * Checks the target is known to fail, each with the reason, such as the
   * task that tracks the gap. A key is a check id, or a check id and a
   * binding as `<id>@<binding>`.
   */
  readonly knownGaps?: Readonly<Record<string, string>>;
  /** Called as each check finishes. */
  readonly onResult?: (result: CheckResult) => void;
  readonly checks?: readonly Check[];
}

const run = randomBytes(3).toString('hex');

export async function runSuite(target: Target, options: SuiteOptions = {}): Promise<Report> {
  const offered = BINDINGS.filter(
    (binding) => target.bindings[binding] !== undefined && (options.bindings?.includes(binding) ?? true),
  );
  const prefixes = await projectPrefixes(target, offered);
  const projectOf = (task: string) => {
    const prefix = task.slice(0, task.lastIndexOf('-'));
    return prefixes.get(prefix) ?? target.projects.main;
  };
  const selected = (options.checks ?? allChecks).filter(
    (check) =>
      target.levels.includes(check.level) &&
      (options.only === undefined || options.only.some((name) => name === check.id || name === check.rule)),
  );
  const results: CheckResult[] = [];
  let serial = 0;
  for (const check of selected) {
    const missing = [
      ...(check.senders ?? []).filter((role) => target.senders[role] === undefined).map((role) => `senders.${role}`),
      ...(check.projects ?? [])
        .filter((project) => target.projects[project] === undefined)
        .map((name) => `projects.${name}`),
    ];
    const bindings: BindingResult[] = [];
    if (missing.length === 0) {
      for (const binding of offered) {
        const trace: string[] = [];
        const apis = new Map<string, Api>();
        const apiFor = (on: BindingName, role: Role): Api => {
          const name = `${on}:${role}`;
          let api = apis.get(name);
          if (!api) {
            api =
              on === 'mcp'
                ? mcpApi(target, role, (line) => trace.push(`[mcp ${role}] ${line}`))
                : httpApi(target, role, projectOf, (line) => trace.push(`[http ${role}] ${line}`));
            apis.set(name, api);
          }
          return api;
        };
        // A person's own interface is the HTTP binding; everyone else arranges over MCP where it is offered.
        const setupBinding = (role: Role): BindingName =>
          role === 'person' && offered.includes('http') ? 'http' : offered.includes('mcp') ? 'mcp' : binding;
        let uniques = 0;
        const context: Context = {
          binding,
          target,
          api: (role = 'agent') => apiFor(binding, role),
          setup: (role = 'agent') => apiFor(setupBinding(role), role),
          unique: (label) => `swp ${run} ${(serial += 1)} ${check.id} ${label} ${(uniques += 1)}`,
          key: () => `swp-${run}-${randomBytes(8).toString('hex')}`,
        };
        try {
          await check.run(context);
          bindings.push({ binding, status: 'passed' });
        } catch (error) {
          if (error instanceof NotOffered) bindings.push({ binding, status: 'not-offered', detail: error.message });
          else if (error instanceof MissingSender) bindings.push({ binding, status: 'not-run', detail: error.message });
          else
            bindings.push({
              binding,
              status: 'failed',
              detail: error instanceof CheckFailed ? error.message : `the check stopped: ${String(error)}`,
              trace,
            });
        }
      }
    }
    const result = judge(check, bindings, missing, options.knownGaps ?? {});
    results.push(result);
    options.onResult?.(result);
  }
  const every = options.checks ?? allChecks;
  const levels = LEVELS.map((level) => {
    const claimed = target.levels.includes(level);
    const own = results.filter((result) => result.level === level);
    const left = own.length < every.filter((check) => check.level === level).length;
    const status = !claimed
      ? ('not-claimed' as const)
      : own.some((result) => result.status === 'failed' || result.status === 'gap-closed')
        ? ('failed' as const)
        : left || own.some((result) => result.status === 'not-run')
          ? ('incomplete' as const)
          : own.some((result) => result.status === 'known-gap')
            ? ('known-gaps' as const)
            : ('passed' as const);
    return { level, claimed, status };
  });
  return {
    target: target.url,
    levels,
    results,
    filtered: selected.length < every.filter((check) => target.levels.includes(check.level)).length,
    passed: results.every((result) => !['failed', 'gap-closed'].includes(result.status)),
  };
}

function judge(
  check: Check,
  bindings: readonly BindingResult[],
  missing: readonly string[],
  knownGaps: Readonly<Record<string, string>>,
): CheckResult {
  const base = {
    id: check.id,
    rule: check.rule,
    section: sectionOf(check.rule),
    level: check.level,
    title: check.title,
    bindings,
  };
  if (missing.length > 0) return { ...base, status: 'not-run', detail: `the target names no ${missing.join(', ')}` };
  const failed = bindings.filter((result) => result.status === 'failed');
  const gaps = [check.id, ...bindings.map((result) => `${check.id}@${result.binding}`)].filter(
    (key) => knownGaps[key] !== undefined,
  );
  const gapCovers = (result: BindingResult) =>
    knownGaps[check.id] !== undefined || knownGaps[`${check.id}@${result.binding}`] !== undefined;
  if (failed.length > 0 && failed.every(gapCovers))
    return { ...base, status: 'known-gap', detail: gaps.map((key) => `${key}: ${knownGaps[key]}`).join('; ') };
  if (failed.length > 0) return { ...base, status: check.strength === 'should' ? 'warned' : 'failed' };
  const unrun = bindings.filter((result) => result.status === 'not-run');
  if (unrun.length > 0)
    return {
      ...base,
      status: 'not-run',
      detail: unrun.map((result) => `${result.binding}: ${result.detail}`).join('; '),
    };
  if (!bindings.some((result) => result.status === 'passed'))
    return { ...base, status: 'not-run', detail: 'no binding the target offers has what the check needs' };
  if (gaps.length > 0)
    return { ...base, status: 'gap-closed', detail: `listed as a gap but passes: ${gaps.join(', ')}` };
  return { ...base, status: 'passed' };
}

/** The project each task-id prefix names, as the senders that may read the target's projects list them. */
async function projectPrefixes(target: Target, offered: readonly BindingName[]): Promise<Map<string, string>> {
  const prefixes = new Map<string, string>();
  const roles: Role[] = ['agent', ...(target.senders.person ? (['person'] as const) : [])];
  for (const binding of offered)
    for (const role of roles) {
      // A person's own interface is the HTTP binding.
      if (role === 'person' && binding === 'mcp') continue;
      const api = binding === 'mcp' ? mcpApi(target, role) : httpApi(target, role, () => target.projects.main);
      const listed = await api.projects();
      if (listed.ok) for (const project of listed.value) prefixes.set(project.prefix, project.projectId);
    }
  return prefixes;
}
