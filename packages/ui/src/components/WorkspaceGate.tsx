import { useQueryClient } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
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
import { NEW_PROJECT_STATE, newWorkspaceRequested, SOURCE_URL } from '../lib/page-state';
import { openingWorkspace, storedWorkspace, storeWorkspace } from '../lib/workspace-choice';
import { usePaths } from '../lib/paths';
import { usePageTitle } from '../lib/page-title';

/**
 * Opens a workspace before any task page draws: the one chosen last in this
 * browser, else the first the sign-in reaches. A sign-in that reaches none
 * sees its first step instead: a deployment admin creates a workspace. A
 * deployment admin's request for another workspace shows the same form in
 * place of the page.
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
  const location = useLocation();
  const paths = usePaths();
  const open = useMemo<OpenWorkspace | null>(
    () => (workspace && list.data ? { workspace, workspaces: list.data, switchTo } : null),
    [workspace, list.data, switchTo],
  );
  // The creation belongs to the gate, not to its form, so a form opened again while one is on its way shows
  // it pending and never sends it twice, and the gate knows whether a form is on screen when it ends.
  const create = useCreateWorkspace();
  const formShown = useRef(false);
  const showsForm = list.data !== undefined && (open === null || newWorkspaceRequested(location.state));
  useLayoutEffect(() => {
    formShown.current = showsForm;
  }, [showsForm]);
  const { mutateAsync } = create;
  // A new workspace joins the list. While its form is on screen it opens at once on Settings's Projects tab,
  // where its first project is made, and Back from there never shows the form again; after Back has left the
  // form, it does not take the page over, and a refusal shows as a notice since no form is there to show it.
  const createWorkspace = useCallback(
    async (name: string, idempotencyKey: string) => {
      const added = await mutateAsync({ name, idempotencyKey }).catch((error: unknown) => {
        if (!formShown.current)
          toast.error(error instanceof Error && error.message !== '' ? error.message : `Could not create ${name}`);
        return null;
      });
      if (added === null) return false;
      client.setQueryData<readonly Workspace[]>(WORKSPACES_KEY, (known = []) => [
        ...known.filter((row) => row.workspaceId !== added.workspaceId),
        added,
      ]);
      void client.invalidateQueries({ queryKey: WORKSPACES_KEY });
      if (formShown.current) {
        setChosen(added.workspaceId);
        void navigate(paths.projects, { replace: true, state: { [NEW_PROJECT_STATE]: true } });
      }
      return true;
    },
    [mutateAsync, client, navigate, paths],
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
  if (open === null) return <FirstStep create={create} onCreate={createWorkspace} />;
  if (newWorkspaceRequested(location.state)) {
    const { pathname, search, hash } = location;
    return (
      <CreateWorkspace
        create={create}
        onCreate={createWorkspace}
        // The menu opened the form as a new history entry, so Cancel goes back to the one before it.
        onCancel={() =>
          void (location.key === 'default' ? navigate({ pathname, search, hash }, { replace: true }) : navigate(-1))
        }
      />
    );
  }
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

/** The gate's creation, which its forms show. */
type Creation = ReturnType<typeof useCreateWorkspace>;

/** Creates a workspace with the name and retry key given, and answers whether it was made. */
type CreateWorkspaceCall = (name: string, idempotencyKey: string) => Promise<boolean>;

/** A deployment admin creates the first workspace; anyone else has none to open. */
function FirstStep({ create, onCreate }: { create: Creation; onCreate: CreateWorkspaceCall }) {
  const account = useAccount(true);
  usePageTitle('New workspace');
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
  if (account.data?.deploymentAdmin) return <CreateWorkspace create={create} onCreate={onCreate} />;
  return (
    <Centered>
      <EmptyState icon={<Building2 aria-hidden />} title="No workspace" />
    </Centered>
  );
}

/**
 * The New workspace form, on a page of its own: the first step of an admin
 * with no workspace, and New workspace in the workspace menu, which adds Cancel.
 */
function CreateWorkspace({
  create,
  onCreate,
  onCancel,
}: {
  create: Creation;
  onCreate: CreateWorkspaceCall;
  /** Leaves the form for the page it opened over; the first step, with no workspace to go back to, has none. */
  onCancel?: () => void;
}) {
  usePageTitle('New workspace');
  const retryKey = useRetryKey();
  const errorId = useId();
  const headingId = useId();
  // A form opened while a creation is on its way shows that creation's name.
  const [name, setName] = useState(() => (create.isPending ? (create.variables?.name ?? '') : ''));
  const trimmed = name.trim();
  const nameError = refusedField(create.error, ['name']) ? (create.error?.message ?? null) : null;
  const formError = create.error && nameError === null ? create.error.message : null;
  const { isPending, reset } = create;
  // A form opened again starts without the last attempt's refusal; this runs only as the form opens.
  useEffect(() => {
    if (!isPending) reset();
  }, []);

  async function submit() {
    if (trimmed === '' || create.isPending) return;
    if (await onCreate(trimmed, retryKey.keyFor(trimmed))) retryKey.done();
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
        <div className="flex flex-col gap-2">
          <Button variant="primary" type="submit" disabled={trimmed === '' || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create workspace'}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" disabled={create.isPending} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </Centered>
  );
}
