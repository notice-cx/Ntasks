import { Folder, Plus } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { refusedField } from '../api/client';
import { PageSkeleton, ReadFailed } from '../components/surface';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { Field, FieldError, Input } from '../components/ui/field';
import { Kbd } from '../components/ui/kbd';
import { Row, RowMeta, RowSpacer, RowTitle } from '../components/ui/row';
import { BarSpacer, ProjectBadge, TopBar } from '../components/ui/shell';
import { useBoard } from '../hooks/useBoard';
import { useShortcut } from '../hooks/useShortcut';
import { useRetryKey } from '../hooks/useTasks';
import { useCreateProject, useIsOwner, useSetDeploys } from '../hooks/useWorkspace';
import { NO_FILTERS } from '../lib/board-read';
import { newProjectRequested } from '../lib/page-state';
import { usePaths } from '../lib/paths';
import { usePageTitle } from '../lib/page-title';

/** The workspace's projects, each a link to its board. An owner creates one with New project (`N`). */
export default function ProjectsRoute() {
  usePageTitle('Projects');
  const owner = useIsOwner();
  const board = useBoard(NO_FILTERS);
  const paths = usePaths();
  const { state } = useLocation();
  const [composing, setComposing] = useState(() => owner && newProjectRequested(state));
  useShortcut('n', () => setComposing(true), owner && !composing);
  const { catalog } = board;
  const deploys = new Map((catalog.data ?? []).map((project) => [project.logicalKey, project.deploys === true]));

  let body: ReactNode;
  if (catalog.isError) {
    body = (
      <div className="p-6 max-sm:p-4">
        <ReadFailed
          title="Couldn't load your projects"
          error={catalog.error}
          retrying={catalog.isFetching}
          onRetry={() => void catalog.refetch()}
        />
      </div>
    );
  } else if (catalog.isPending) {
    body = (
      <div className="p-6 max-sm:p-4">
        <PageSkeleton shape="list" />
      </div>
    );
  } else if (board.available.length === 0) {
    body = composing ? null : (
      <EmptyState
        icon={<Folder aria-hidden />}
        title="No projects"
        action={
          owner ? (
            <Button size="sm" onClick={() => setComposing(true)}>
              New project
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <ul className="m-0 list-none p-0" aria-label="Projects">
        {board.available.map((project) => (
          <li key={project.key}>
            <Row data-project-row={project.key}>
              <ProjectBadge prefix={project.prefix} />
              <RowTitle>
                <Link
                  to={`${paths.board}?project=${encodeURIComponent(project.key)}`}
                  className="text-ink no-underline outline-none focus-visible:underline"
                >
                  {project.name}
                </Link>
              </RowTitle>
              <RowMeta>{project.prefix}</RowMeta>
              <RowSpacer />
              {project.ok ? (
                <span className="nums shrink-0 text-meta text-ink-3">
                  {project.tasks.filter((task) => task.status !== 'closed').length} open
                </span>
              ) : null}
              <DeploysBox
                project={project.key}
                name={project.name}
                deploys={deploys.get(project.key) ?? false}
                owner={owner}
              />
            </Row>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <TopBar title="Projects">
        <BarSpacer />
        {owner ? (
          <Button
            variant="primary"
            disabled={composing}
            onClick={() => setComposing(true)}
            aria-label="New project"
            aria-keyshortcuts="N"
            className="max-sm:w-9 max-sm:px-0"
          >
            <Plus aria-hidden strokeWidth={2} />
            <span className="max-sm:hidden">New project</span>
            <Kbd className="max-sm:hidden">N</Kbd>
          </Button>
        ) : null}
      </TopBar>
      {composing ? <NewProjectForm onDone={() => setComposing(false)} /> : null}
      {body}
    </>
  );
}

/** Whether a project's changes go live by a deploy: an owner ticks it; anyone else sees it. */
function DeploysBox({
  project,
  name,
  deploys,
  owner,
}: {
  project: string;
  name: string;
  deploys: boolean;
  owner: boolean;
}) {
  const set = useSetDeploys();
  const checked = set.isPending ? set.variables.deploys : deploys;
  return (
    <label className="flex shrink-0 items-center gap-2 text-meta text-ink-2" data-project-deploys={project}>
      <input
        type="checkbox"
        className="size-[15px] accent-accent"
        checked={checked}
        disabled={!owner || set.isPending}
        aria-label={`${name}: changes go live by a deploy`}
        onChange={(event) =>
          set.mutate(
            { project, deploys: event.target.checked },
            { onError: (error) => toast.error(error.message || `Could not change ${name}`) },
          )
        }
      />
      <span className="max-sm:hidden">Changes go live by a deploy</span>
    </label>
  );
}

/** Name and prefix, both required. A refusal shows under the field it is about. */
function NewProjectForm({ onDone }: { onDone: () => void }) {
  const create = useCreateProject();
  const retryKey = useRetryKey();
  const errorId = useId();
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const input = { name: name.trim(), prefix: prefix.trim() };
  const ready = input.name !== '' && input.prefix !== '' && !create.isPending;
  const refused = refusedField(create.error, ['name', 'prefix'] as const);
  const said = create.error?.message ?? null;

  async function submit() {
    if (!ready) return;
    const made = await create.mutateAsync({ input, idempotencyKey: retryKey.keyFor(JSON.stringify(input)) }).then(
      () => true,
      () => false,
    );
    if (!made) return;
    retryKey.done();
    toast.success(`Created ${input.name}`);
    onDone();
  }

  return (
    <div className="border-b border-border px-5.5 py-4 max-sm:px-4">
      <form
        className="flex flex-col gap-3 rounded-xl bg-surface px-4 py-3.5 inset-ring inset-ring-border"
        aria-label="New project"
        data-new-project=""
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onDone();
        }}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_180px] items-start gap-2 max-sm:grid-cols-1">
          <Field label="Name" required error={refused === 'name' ? said : null}>
            <Input
              autoFocus
              autoComplete="off"
              value={name}
              disabled={create.isPending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Prefix" required error={refused === 'prefix' ? said : null}>
            <Input
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={prefix}
              disabled={create.isPending}
              onChange={(event) => setPrefix(event.target.value.toLowerCase())}
            />
          </Field>
        </div>
        {said !== null && refused === null ? <FieldError id={errorId}>{said}</FieldError> : null}
        <div className="flex items-center gap-2">
          <Button variant="primary" type="submit" disabled={!ready}>
            {create.isPending ? 'Creating…' : 'Create project'}
          </Button>
          <Button type="button" variant="ghost" disabled={create.isPending} onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
