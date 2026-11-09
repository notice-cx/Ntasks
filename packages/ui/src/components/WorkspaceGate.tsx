import { useQueryClient } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { useCallback, useId, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { needsSignIn, refusedField } from '../api/client';
import { useAnswerQueue, useTasksApi } from '../api/context';
import type { Workspace } from '../api/types';
import { PageSkeleton, ReadFailed, SignIn } from './surface';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { Field, FieldError, Input } from './ui/field';
import { GitHubMark, NtasksLogo } from './ui/symbols';
import { useRetryKey } from '../hooks/useTasks';
import {
  inWorkspace,
  useAccount,
  useCreateWorkspace,
  useWorkspaceList,
  WORKSPACES_KEY,
  WorkspaceContext,
  type OpenWorkspace,
} from '../hooks/useWorkspace';
import { NEW_PROJECT_STATE, SOURCE_URL } from '../lib/page-state';
import { openingWorkspace, storedWorkspace, storeWorkspace } from '../lib/workspace-choice';
import { usePaths } from '../lib/paths';

/**
 * Opens a workspace before any task page draws: the one chosen last in this
 * browser, else the first the sign-in reaches. A sign-in that reaches none
 * sees its first step instead: a deployment admin creates a workspace.
 */
export function WorkspaceGate() {
  const api = useTasksApi();
  const answers = useAnswerQueue();
  const client = useQueryClient();
  const list = useWorkspaceList();
  const [chosen, setChosen] = useState(storedWorkspace);
  const workspace = list.data ? openingWorkspace(list.data, chosen) : null;
  const id = workspace?.workspaceId ?? null;
  /** The workspace every API call and every cached read is in. */
  const [ready, setReady] = useState<string | null>(null);

  // Before a page draws in another workspace, an answer still in its Undo
  // window goes in the workspace it was given in, the last workspace's reads
  // are dropped, and every call from then on names this one.
  useLayoutEffect(() => {
    if (id === null || id === ready) return;
    if (ready !== null) {
      answers.flush(true);
      void client.cancelQueries({ predicate: inWorkspace });
      client.removeQueries({ predicate: inWorkspace });
    }
    api.selectWorkspace(id);
    storeWorkspace(id);
    setReady(id);
  }, [id, ready, api, answers, client]);

  const switchTo = useCallback((next: string) => setChosen(next), []);
  const navigate = useNavigate();
  const paths = usePaths();
  // A new workspace opens at once on its Projects page, where its first project is made.
  const created = useCallback(
    (added: Workspace) => {
      client.setQueryData<readonly Workspace[]>(WORKSPACES_KEY, (known = []) => [
        ...known.filter((row) => row.workspaceId !== added.workspaceId),
        added,
      ]);
      setChosen(added.workspaceId);
      void navigate(paths.projects, { state: { [NEW_PROJECT_STATE]: true } });
      void client.invalidateQueries({ queryKey: WORKSPACES_KEY });
    },
    [client, navigate, paths],
  );
  const open = useMemo<OpenWorkspace | null>(
    () => (workspace && list.data ? { workspace, workspaces: list.data, switchTo } : null),
    [workspace, list.data, switchTo],
  );

  if (list.data === undefined) {
    if (!list.isError) return <Loading />;
    return (
      <Centered>
        {needsSignIn(list.error) ? (
          <SignIn />
        ) : (
          <ReadFailed
            title="Couldn't load your workspaces"
            error={list.error}
            retrying={list.isFetching}
            onRetry={() => void list.refetch()}
          />
        )}
      </Centered>
    );
  }
  if (open === null) return <FirstStep onCreated={created} />;
  if (ready !== open.workspace.workspaceId) return <Loading />;
  return (
    <WorkspaceContext.Provider value={open}>
      {/* Every page starts again in the workspace it opens. */}
      <Outlet key={ready} />
    </WorkspaceContext.Provider>
  );
}

function Loading() {
  return (
    <div className="min-h-screen bg-background p-6 max-sm:p-4">
      <PageSkeleton shape="list" />
    </div>
  );
}

/** A page of its own, outside the app's frame, such as the step a sign-in with no workspace takes. It keeps the link to the source code. */
function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-canvas p-4">
      <div className="flex w-full max-w-100 flex-col items-center gap-4">
        <div className="w-full">{children}</div>
        <a
          href={SOURCE_URL}
          className="inline-flex items-center gap-1.5 rounded-sm text-meta text-ink-3 no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          data-source-link=""
        >
          <GitHubMark size={14} />
          Source code
        </a>
      </div>
    </main>
  );
}

/** A deployment admin creates the first workspace; anyone else has none to open. */
function FirstStep({ onCreated }: { onCreated: (workspace: Workspace) => void }) {
  const account = useAccount(true);
  if (account.isPending) return <Loading />;
  if (account.isError) {
    // Without the account it is unknown whether this person may create a workspace.
    return (
      <Centered>
        <ReadFailed
          title="Couldn't load your account"
          error={account.error}
          retrying={account.isFetching}
          onRetry={() => void account.refetch()}
        />
      </Centered>
    );
  }
  if (account.data?.deploymentAdmin) return <CreateWorkspace onCreated={onCreated} />;
  return (
    <Centered>
      <EmptyState icon={<Building2 aria-hidden />} title="No workspace" />
    </Centered>
  );
}

function CreateWorkspace({ onCreated }: { onCreated: (workspace: Workspace) => void }) {
  const create = useCreateWorkspace();
  const retryKey = useRetryKey();
  const errorId = useId();
  const headingId = useId();
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const nameError = refusedField(create.error, ['name']) ? (create.error?.message ?? null) : null;
  const formError = create.error && nameError === null ? create.error.message : null;

  async function submit() {
    if (trimmed === '' || create.isPending) return;
    const created = await create
      .mutateAsync({ name: trimmed, idempotencyKey: retryKey.keyFor(trimmed) })
      .catch(() => null);
    if (created === null) return;
    retryKey.done();
    onCreated(created);
  }

  return (
    <Centered>
      <form
        className="flex flex-col gap-4 rounded-xl bg-background p-6 shadow-pop"
        aria-labelledby={headingId}
        noValidate
        data-first-step="workspace"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <NtasksLogo size={28} />
        <h1 id={headingId} className="m-0 text-heading text-ink">
          New workspace
        </h1>
        <Field label="Name" required error={nameError}>
          <Input
            autoFocus
            autoComplete="off"
            value={name}
            disabled={create.isPending}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {formError ? <FieldError id={errorId}>{formError}</FieldError> : null}
        <Button variant="primary" type="submit" disabled={trimmed === '' || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create workspace'}
        </Button>
      </form>
    </Centered>
  );
}
