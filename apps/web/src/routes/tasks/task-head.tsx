import type { ReactNode } from 'react';
import { ChevronRight, GitPullRequest } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { TaskResolution } from '@ntasks/domain';
import type { TaskChoice, TaskChoices, TaskDelivery } from '@/api/types';
import { Avatar } from '@/components/ui/avatar';
import { OptionList } from '@/components/ui/choice';
import { ProjectBadge } from '@/components/ui/shell';
import { StatusMark } from '@/components/ui/symbols';
import { ageMs, formatAge } from '@/lib/format';
import { choiceName, RESOLUTION_LABELS, stageLabel } from '@/lib/task-model';
import { taskPath } from '@/lib/task-path';
import { cardOptions } from './decision-card';

/** Who did something on a task, as an avatar draws them. */
export interface Actor {
  name: string;
  agent: boolean;
  model: string | null;
}

/**
 * The task's place, as the top bar's title: its project, its epic when it
 * has one, then its id. A phone hides the project's name beside its badge,
 * so the link carries the name.
 */
export function TaskPath({
  id,
  project,
  parent,
}: {
  id: string;
  project: { name: string; prefix: string; to: string } | null;
  parent: { id: string; title: string | null } | null;
}) {
  const crumb = 'flex min-w-0 items-center gap-1.5 text-ink-3 no-underline hover:text-ink';
  return (
    <nav aria-label="Path" className="flex min-w-0 items-center gap-1.5 text-label font-medium text-ink-3">
      {project ? (
        <>
          <Link to={project.to} aria-label={project.name} className={crumb}>
            <ProjectBadge prefix={project.prefix} />
            <span className="truncate max-sm:hidden">{project.name}</span>
          </Link>
          <ChevronRight aria-hidden size={14} className="shrink-0" />
        </>
      ) : null}
      {parent ? (
        <>
          <Link to={taskPath(parent.id)} title={parent.title ?? undefined} className={crumb}>
            <span className="nums whitespace-nowrap">{parent.id}</span>
          </Link>
          <ChevronRight aria-hidden size={14} className="shrink-0" />
        </>
      ) : null}
      <span className="nums whitespace-nowrap text-ink-2" aria-current="page">
        {id}
      </span>
    </nav>
  );
}

/** Who did it and how long ago, after what they did: an avatar, the name, the model they named, the age. */
function Byline({ by, at, nowMs }: { by: Actor | null; at: string | null; nowMs: number }) {
  const age = ageMs(nowMs, at);
  return (
    <>
      {by ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Avatar name={by.name} agent={by.agent} model={by.model} decorative />
          <span className="font-medium text-ink">{by.name}</span>
          {by.model ? <span className="text-ink-3">{by.model}</span> : null}
        </span>
      ) : null}
      {age !== null ? (
        <time className="nums ms-auto text-meta text-ink-3" dateTime={at ?? undefined}>
          {formatAge(age)}
        </time>
      ) : null}
    </>
  );
}

/** A pull request's name: `owner/name#12` for GitHub's, its host and path for any other. */
function pullRequestName(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const pull = /^\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(parsed.pathname);
  return parsed.hostname === 'github.com' && pull ? `${pull[1]}#${pull[2]}` : `${parsed.host}${parsed.pathname}`;
}

/** Where a closed task's change is: its stage, then its pull request and commit. */
function DeliveryLine({ delivery }: { delivery: TaskDelivery }) {
  const { stage, pullRequest, commit, mergeCommit } = delivery;
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-ink-2" data-task-delivery={stage}>
      <span className="font-medium text-ink">{stageLabel(stage)}</span>
      {pullRequest ? (
        <a
          href={pullRequest}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-accent-text no-underline hover:underline"
        >
          <GitPullRequest aria-hidden size={14} />
          {pullRequestName(pullRequest)}
        </a>
      ) : null}
      {commit ? <code className="font-mono text-meta text-ink-3">{commit.slice(0, 7)}</code> : null}
      {mergeCommit && mergeCommit !== commit ? (
        <span className="text-ink-3">
          merged as <code className="font-mono text-meta">{mergeCommit.slice(0, 7)}</code>
        </span>
      ) : null}
    </p>
  );
}

/** What shows the work of a task closed as done without a commit or pull request: its link, or that it has none. */
function ProofLine({ link }: { link: string | null }) {
  return (
    <p
      className="m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-ink-2"
      data-task-proof={link === null ? 'none' : 'link'}
    >
      {link === null ? (
        <>
          <span className="font-medium text-ink">No proof</span>
          <span>Closed as done without a commit, pull request or link.</span>
        </>
      ) : (
        <a href={link} target="_blank" rel="noreferrer" className="text-accent-text no-underline hover:underline">
          {pullRequestName(link)}
        </a>
      )}
    </p>
  );
}

/**
 * How a closed task ended, under its title: Done, or the way a close where
 * nothing shipped ended, who closed it and when, where its change is or what
 * else shows it, then the evidence or note. Closing records what shipped, not
 * a measured outcome, so it is drawn in greys like any other fact.
 */
export function ClosedSummary({
  by,
  at,
  nowMs,
  resolution,
  duplicate,
  delivery,
  link = null,
  proof = null,
  children,
}: {
  by: Actor | null;
  at: string | null;
  nowMs: number;
  resolution: TaskResolution;
  duplicate?: ReactNode;
  delivery?: TaskDelivery | null;
  /** The URL the close named to show the work. */
  link?: string | null;
  proof?: 'none' | null;
  children?: ReactNode;
}) {
  const label = RESOLUTION_LABELS[resolution];
  return (
    <section
      aria-label={`Closed as ${label}`}
      data-task-closed=""
      data-task-resolution={resolution}
      className="flex flex-col gap-2 rounded-xl bg-surface px-4 py-3 inset-ring inset-ring-border"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-ink-2">
        <StatusMark status="done" muted={resolution !== 'done'} label={null} />
        <h2 className="m-0 text-sm font-semibold text-ink">
          {label}
          {duplicate ? <> of {duplicate}</> : null}
        </h2>
        <Byline by={by} at={at} nowMs={nowMs} />
      </div>
      {delivery ? <DeliveryLine delivery={delivery} /> : null}
      {link !== null || proof === 'none' ? <ProofLine link={link} /> : null}
      {children}
    </section>
  );
}

/** A decision's recorded pick: what was chosen, by whom and when, their note, then the options as a record. */
export function ChoiceSummary({
  choice,
  choices,
  by,
  nowMs,
}: {
  choice: TaskChoice;
  choices: TaskChoices | null;
  by: Actor;
  nowMs: number;
}) {
  return (
    <section aria-label="Choice" data-task-choice={choice.option} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-ink-2">
        <h2 className="m-0 text-sm font-semibold text-ink">Chose {choiceName(choice.option, choice.label)}</h2>
        <Byline by={by} at={choice.at} nowMs={nowMs} />
      </div>
      {choice.note ? <p className="m-0 text-body whitespace-pre-line text-ink">{choice.note}</p> : null}
      {choices ? (
        <OptionList question={choices.question} options={cardOptions(choices)} value={choice.option} readOnly />
      ) : null}
    </section>
  );
}
