import { Folder, Plus } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { refusedField } from '../../api/client';
import type { ProjectEdit, TaskProject } from '../../api/types';
import { ProjectIcon } from '../../components/ProjectIcon';
import { PageSkeleton, ReadFailed } from '../../components/surface';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Checkbox, Field, FieldError, Input } from '../../components/ui/field';
import { Kbd } from '../../components/ui/kbd';
import { Row, RowMeta, RowSpacer, RowTitle } from '../../components/ui/row';
import { SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { useShortcut } from '../../hooks/useShortcut';
import { useRetryKey, useTaskProjects } from '../../hooks/useTasks';
import { useCreateProject, useIsOwner, useUpdateProject } from '../../hooks/useWorkspace';
import { newProjectRequested } from '../../lib/page-state';
import { usePaths } from '../../lib/paths';

/**
 * Settings's Projects tab: the workspace's projects, each its icon, name and
 * prefix. An owner creates one with New project (`N`) and, with Edit,
 * renames one, sets its website, whose icon then stands for it, says whether
 * its changes go live by a deploy, and enables or disables it.
 */
export function ProjectsSection() {
  const owner = useIsOwner();
  const catalog = useTaskProjects();
  const { state } = useLocation();
  const [composing, setComposing] = useState(() => owner && newProjectRequested(state));
  const [editing, setEditing] = useState<string | null>(null);
  useShortcut('n', () => setComposing(true), owner && !composing);

  let body: ReactNode;
  if (catalog.isError) {
    body = (
      <ReadFailed
        title="Couldn't load your projects"
        error={catalog.error}
        retrying={catalog.isFetching}
        onRetry={() => void catalog.refetch()}
      />
    );
  } else if (catalog.isPending) {
    body = <PageSkeleton shape="list" />;
  } else if (catalog.data.length === 0) {
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
      <SettingsGroup>
        <ul className="m-0 list-none p-0 [&>li+li]:border-t [&>li+li]:border-border" aria-label="Projects">
          {catalog.data.map((project) => (
            <li key={project.logicalKey}>
              <ProjectRow
                project={project}
                owner={owner}
                editing={editing === project.logicalKey}
                onEdit={() => setEditing(project.logicalKey)}
              />
              {owner && editing === project.logicalKey ? (
                <ProjectEditor key={project.logicalKey} project={project} onDone={() => setEditing(null)} />
              ) : null}
            </li>
          ))}
        </ul>
      </SettingsGroup>
    );
  }

  return (
    <SettingsSection
      title="Projects"
      description="Each project's name, website and deploys. A disabled project takes no new tasks."
      action={
        owner ? (
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
        ) : undefined
      }
    >
      {composing ? <NewProjectForm onDone={() => setComposing(false)} /> : null}
      {body}
    </SettingsSection>
  );
}

/** A project's line: its icon, its name, a link to its board while it is enabled, its prefix and what is set. */
function ProjectRow({
  project,
  owner,
  editing,
  onEdit,
}: {
  project: TaskProject;
  owner: boolean;
  editing: boolean;
  onEdit: () => void;
}) {
  const paths = usePaths();
  const disabled = project.disabled === true;
  return (
    <Row data-project-row={project.logicalKey} className="border-b-0 ps-4 pe-2">
      <ProjectIcon project={project} size={20} />
      <RowTitle className={disabled ? 'text-ink-3' : undefined}>
        {disabled ? (
          project.displayName
        ) : (
          <Link
            to={paths.project(project.logicalKey)}
            className="text-ink no-underline outline-none focus-visible:underline"
          >
            {project.displayName}
          </Link>
        )}
      </RowTitle>
      <RowMeta>{project.prefix}</RowMeta>
      <RowSpacer />
      {project.deploys === true ? <Badge className="max-sm:hidden">Deploys</Badge> : null}
      {disabled ? <Badge>Disabled</Badge> : null}
      {owner && !editing ? (
        <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${project.displayName}`}>
          Edit
        </Button>
      ) : null}
    </Row>
  );
}

/**
 * An owner's settings of one project, saved together: Name, required;
 * Website, whose icon the server reads when it changes; whether its changes
 * go live by a deploy; and whether it is enabled. Save sends only what
 * changed. A refusal shows under the field it is about.
 */
function ProjectEditor({ project, onDone }: { project: TaskProject; onDone: () => void }) {
  const update = useUpdateProject();
  const errorId = useId();
  const [name, setName] = useState(project.displayName);
  const [website, setWebsite] = useState(project.websiteUrl ?? '');
  const [deploys, setDeploys] = useState(project.deploys === true);
  const [enabled, setEnabled] = useState(project.disabled !== true);
  const edit: ProjectEdit = {
    ...(name.trim() !== project.displayName ? { displayName: name.trim() } : {}),
    ...(website.trim() !== (project.websiteUrl ?? '')
      ? { websiteUrl: website.trim() === '' ? null : website.trim() }
      : {}),
    ...(deploys !== (project.deploys === true) ? { deploys } : {}),
    ...(enabled !== (project.disabled !== true) ? { disabled: !enabled } : {}),
  };
  const changed = Object.keys(edit).length > 0;
  const ready = changed && name.trim() !== '' && !update.isPending;
  const refused = refusedField(update.error, ['displayName', 'websiteUrl'] as const);
  const said = update.error?.message ?? null;
  const edited = () => {
    // The refusal was about what was sent; an edit makes it stale.
    if (update.isError) update.reset();
  };

  function save() {
    if (!ready) return;
    update.mutate(
      { project: project.logicalKey, edit },
      {
        onSuccess: (saved) => {
          if (typeof edit.websiteUrl === 'string' && !saved.icon) toast(`No icon found at ${hostOf(saved.websiteUrl)}`);
          else toast.success(`Saved ${saved.displayName}`);
          onDone();
        },
      },
    );
  }

  return (
    <form
      className="flex flex-col gap-3 border-t border-border bg-surface px-4 py-3.5"
      aria-label={`Edit ${project.displayName}`}
      data-project-editor={project.logicalKey}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onDone();
      }}
    >
      <div className="grid grid-cols-2 items-start gap-3 max-sm:grid-cols-1">
        <Field label="Name" required error={refused === 'displayName' ? said : null}>
          <Input
            autoFocus
            autoComplete="off"
            value={name}
            disabled={update.isPending}
            onChange={(event) => {
              edited();
              setName(event.target.value);
            }}
          />
        </Field>
        <Field label="Website" error={refused === 'websiteUrl' ? said : null}>
          <Input
            type="url"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="https://example.com"
            value={website}
            disabled={update.isPending}
            onChange={(event) => {
              edited();
              setWebsite(event.target.value);
            }}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Checkbox
          label="Changes go live by a deploy"
          checked={deploys}
          disabled={update.isPending}
          onChange={setDeploys}
          data-project-deploys={project.logicalKey}
        />
        <Checkbox
          label="Enabled"
          checked={enabled}
          disabled={update.isPending}
          onChange={setEnabled}
          data-project-enabled={project.logicalKey}
        />
      </div>
      {said !== null && refused === null ? <FieldError id={errorId}>{said}</FieldError> : null}
      <div className="flex items-center gap-2">
        <Button variant="primary" type="submit" disabled={!ready}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" disabled={update.isPending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The host of a website, as a person reads it; the address itself when it has none. */
function hostOf(website: string | null | undefined): string {
  try {
    return new URL(website ?? '').host;
  } catch {
    return website ?? 'this website';
  }
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
  );
}
