import { useRef, type ReactNode } from 'react';
import { ChevronRight, GitPullRequest, Minus } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { TaskResolution } from '@ntasks/domain';
import type { TaskAcceptance, TaskAnswer, TaskChoice, TaskChoiceKey, TaskChoices, TaskDelivery } from '../../api/types';
import { Avatar } from '../../components/ui/avatar';
import { CopyButton } from '../../components/ui/copy-button';
import { OptionList } from '../../components/ui/choice';
import { ProjectIcon } from '../../components/ProjectIcon';
import { StatusMark } from '../../components/ui/symbols';
import { ageMs, formatAge, pullRequestName } from '../../lib/format';
import { cn } from '../../lib/utils';
import { choiceName, RESOLUTION_LABELS, stageLabel, waivedCount } from '../../lib/task-model';
import { usePaths } from '../../lib/paths';
import { cardOptions } from './decision-card';

/** Who did something on a task, as an avatar draws them. */
export interface Actor {
  name: string;
  agent: boolean;
  model: string | null;
}

/**
 * The task's place, as the top bar's title: its project, its epic when it
 * has one, then its id, with a button that copies the id. A phone hides the
 * project's name beside its badge, so the link carries the name.
 */
export function TaskPath({
  id,
  project,
  parent,
}: {
  id: string;
  project: { name: string; prefix: string; icon?: string | null; darkIcon?: string | null; to: string } | null;
  parent: { id: string; title: string | null } | null;
}) {
  const paths = usePaths();
  const here = useRef<HTMLSpanElement>(null);
  const crumb = 'flex min-w-0 items-center gap-1.5 text-ink-3 no-underline hover:text-ink';
  return (
    <nav aria-label="Path" className="flex min-w-0 items-center gap-1.5 text-label font-medium text-ink-3">
      {/* On a phone the path is this task alone: its project and its epic are facts on the page. */}
      {project ? (
        <>
          <Link to={project.to} aria-label={project.name} className={cn(crumb, 'max-sm:hidden')}>
            <ProjectIcon project={project} />
            <span className="truncate">{project.name}</span>
          </Link>
          <ChevronRight aria-hidden size={14} className="shrink-0 max-sm:hidden" />
        </>
      ) : null}
      {parent ? (
        <>
          <Link to={paths.task(parent.id)} title={parent.title ?? undefined} className={cn(crumb, 'max-sm:hidden')}>
            <span className="nums truncate">{parent.id}</span>
          </Link>
          <ChevronRight aria-hidden size={14} className="shrink-0 max-sm:hidden" />
        </>
      ) : null}
      <span ref={here} className="nums min-w-0 truncate text-ink-2" aria-current="page">
        {id}
      </span>
      <CopyButton label="Copy the task id" target={here} text={() => id} className="-my-1 -ms-1" />
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

/** A person's acceptance of a task as done, with the names its record gives drawn as the page names them. */
export interface AcceptanceShown {
  readonly acceptance: TaskAcceptance;
  /** The person who accepted it. */
  readonly person: string;
  /** The agent or service that relayed it, when one did. */
  readonly relayer: string | null;
}

/**
 * A close as done on a person's own call: who accepted it and how many
 * criteria they waived, who relayed it and from where with the person's
 * words, then each criterion they waived.
 */
function AcceptanceLines({ shown }: { shown: AcceptanceShown }) {
  const { acceptance, person, relayer } = shown;
  const waived = acceptance.criteria.filter((criterion) => !criterion.met);
  const counted =
    acceptance.criteria.length === 0
      ? ''
      : waived.length === 0
        ? ' · every criterion met'
        : ` · ${waivedCount(waived.length)} waived`;
  return (
    <>
      <p
        className="m-0 text-label text-ink-2 [overflow-wrap:anywhere]"
        data-task-acceptance={acceptance.relayed ? 'relayed' : 'direct'}
      >
        Accepted by <span className="font-medium text-ink">{person}</span>
        {counted}
      </p>
      {acceptance.relayed ? (
        <>
          <p className="m-0 text-meta text-ink-3 [overflow-wrap:anywhere]">
            Relayed by {relayer ?? acceptance.relayed.by} from {acceptance.relayed.source}
          </p>
          <blockquote className="m-0 border-s-2 border-border-strong ps-3 text-body whitespace-pre-line text-ink-2">
            {acceptance.relayed.quote}
          </blockquote>
        </>
      ) : null}
      {waived.length > 0 ? (
        <ul aria-label="Waived" className="m-0 flex list-none flex-col gap-1 p-0 text-label text-ink-2">
          {waived.map((criterion, index) => (
            <li key={index} className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
              <Minus aria-hidden size={14} className="mt-[3px] shrink-0 text-ink-3" />
              {criterion.text}
            </li>
          ))}
        </ul>
      ) : null}
    </>
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
  acceptance = null,
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
  /** A person's acceptance of it as done on their own call. */
  acceptance?: AcceptanceShown | null;
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
      {acceptance ? <AcceptanceLines shown={acceptance} /> : null}
      {children}
    </section>
  );
}

/** What an answer chose, as its heading names it. */
function answerHeading(answer: TaskAnswer, choices: TaskChoices | null): string {
  if (answer.option === 'approve') return 'Approved';
  if (answer.option === 'done') return 'Done';
  if (answer.option === 'decline') return 'Declined';
  if (answer.option === null) return 'Answered';
  const label = choices?.options.find((option) => option.key === answer.option)?.label;
  return label === undefined
    ? `Chose (${answer.option})`
    : `Chose ${choiceName(answer.option as TaskChoiceKey, label)}`;
}

/**
 * An answer an agent or a service recorded for a person: what it chose, who
 * recorded it and when, where the person said it and their words, then
 * `children`, such as the Dispute that withdraws it.
 */
export function AnswerSummary({
  answer,
  choices,
  by,
  nowMs,
  children,
}: {
  answer: TaskAnswer;
  choices: TaskChoices | null;
  by: Actor;
  nowMs: number;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label="Recorded answer"
      data-task-answer=""
      className="flex flex-col gap-2 rounded-xl bg-surface px-4 py-3 inset-ring inset-ring-border"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-ink-2">
        <h2 className="m-0 text-sm font-semibold text-ink">{answerHeading(answer, choices)}</h2>
        <Byline by={by} at={answer.at} nowMs={nowMs} />
      </div>
      <p className="m-0 text-meta text-ink-3 [overflow-wrap:anywhere]">
        {answer.relayed ? 'Relayed' : 'Answered here'}
        {answer.source ? ` from ${answer.source}` : ''}
        {answer.disputedBy ? ` · Disputed by ${answer.disputedBy}` : ''}
      </p>
      {answer.quote ? (
        <blockquote className="m-0 border-s-2 border-border-strong ps-3 text-body whitespace-pre-line text-ink-2">
          {answer.quote}
        </blockquote>
      ) : null}
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
