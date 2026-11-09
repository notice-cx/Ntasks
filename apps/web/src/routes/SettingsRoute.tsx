import { Copy } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { refusedField } from '@/api/client';
import type { ConnectedApp, Workspace } from '@/api/types';
import { PageSkeleton, ReadFailed } from '@/components/surface';
import { Button, IconButton } from '@/components/ui/button';
import { Field, FieldError, Input } from '@/components/ui/field';
import { Row, RowMeta, RowSpacer, RowTitle } from '@/components/ui/row';
import { TopBar } from '@/components/ui/shell';
import { WorkspaceIcon } from '@/components/ui/symbols';
import { useRetryKey } from '@/hooks/useTasks';
import {
  useApps,
  useRegisterApp,
  useRemoveApp,
  useRenameWorkspace,
  useRevokeApp,
  useWorkspace,
} from '@/hooks/useWorkspace';
import { copyText } from '@/lib/clipboard';

/**
 * The open workspace's name and id, and its connected apps. An owner renames
 * it; anyone else reads the name. The name is only shown: the API and agents
 * name a workspace by its id, which never changes.
 */
export default function SettingsRoute() {
  const { workspace } = useWorkspace();
  return (
    <>
      <TopBar title="Settings" />
      <div className="flex max-w-140 flex-col gap-5 px-6 py-6 max-sm:px-4">
        <div className="flex items-center gap-3">
          <WorkspaceIcon workspaceId={workspace.workspaceId} name={workspace.name} size={32} />
          <p className="m-0 text-label text-ink-2">People see the name; agents and the API use the ID.</p>
        </div>
        {workspace.role === 'owner' ? (
          <RenameForm workspace={workspace} />
        ) : (
          <Setting label="Name">
            <span className="min-w-0 truncate">{workspace.name}</span>
          </Setting>
        )}
        <Setting label="ID">
          <code className="min-w-0 truncate font-mono text-code text-ink">{workspace.workspaceId}</code>
          <IconButton
            size="sm"
            label="Copy ID"
            icon={<Copy aria-hidden />}
            onClick={() => void copyText(workspace.workspaceId, 'the ID')}
          />
        </Setting>
        <ConnectedApps owner={workspace.role === 'owner'} />
      </div>
    </>
  );
}

/**
 * The workspace's connected apps. Each acts as whoever signs in to it, in
 * this workspace alone. A person signed in to one revokes their own sign-in;
 * an owner registers an app, copies its client ID for the product that runs
 * it, and removes it for everyone.
 */
function ConnectedApps({ owner }: { owner: boolean }) {
  const apps = useApps();
  const [registering, setRegistering] = useState(false);
  let list: ReactNode;
  if (apps.isError)
    list = (
      <ReadFailed
        title="Couldn't load the apps"
        error={apps.error}
        retrying={apps.isFetching}
        onRetry={() => void apps.refetch()}
      />
    );
  else if (apps.isPending) list = <PageSkeleton shape="list" />;
  else if (apps.data.length === 0) list = <p className="m-0 text-label text-ink-3">No apps yet.</p>;
  else
    list = (
      <ul className="m-0 list-none overflow-hidden rounded-lg p-0 inset-ring inset-ring-border [&>li:last-child>div]:border-b-0">
        {apps.data.map((app) => (
          <AppRow key={app.clientId} app={app} owner={owner} />
        ))}
      </ul>
    );
  return (
    <section aria-label="Connected apps" className="flex flex-col gap-3 pt-2">
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-label font-medium text-ink">Connected apps</h2>
        <span className="flex-1" />
        {owner && !registering ? (
          <Button size="sm" onClick={() => setRegistering(true)}>
            Register app
          </Button>
        ) : null}
      </div>
      <p className="m-0 text-label text-ink-2">An app here acts as whoever signs in to it, in this workspace only.</p>
      {owner && registering ? <RegisterAppForm onDone={() => setRegistering(false)} /> : null}
      {list}
    </section>
  );
}

/** One app: its name and where it runs, and its actions. Revoke shows only while the person is signed in to it. */
function AppRow({ app, owner }: { app: ConnectedApp; owner: boolean }) {
  const revoke = useRevokeApp();
  const remove = useRemoveApp();
  const [confirming, setConfirming] = useState(false);
  const where = app.redirectUris[0] ? new URL(app.redirectUris[0]).host : null;
  return (
    <li>
      <Row data-app-row={app.clientId} className="ps-3 pe-2">
        <RowTitle>{app.name}</RowTitle>
        {/* The address gives way before the name does. */}
        {where ? <RowMeta className="block min-w-0 shrink-[4] truncate">{where}</RowMeta> : null}
        <RowSpacer />
        {owner ? (
          <IconButton
            size="sm"
            label="Copy client ID"
            icon={<Copy aria-hidden />}
            onClick={() => void copyText(app.clientId, 'the client ID')}
          />
        ) : null}
        {app.connectedAt && !confirming ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={revoke.isPending}
            onClick={() =>
              revoke.mutate(app.clientId, {
                onSuccess: () => toast.success(`Signed out of ${app.name}`),
                onError: (error) => toast.error(error.message),
              })
            }
          >
            {revoke.isPending ? 'Revoking…' : 'Revoke'}
          </Button>
        ) : null}
        {owner && !confirming ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        ) : null}
        {owner && confirming ? (
          <>
            <span className="shrink-0 text-meta text-ink-2 max-sm:hidden">Remove for everyone?</span>
            <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={remove.isPending}
              data-confirm-remove=""
              onClick={() =>
                remove.mutate(app.clientId, {
                  onSuccess: () => toast.success(`Removed ${app.name}`),
                  onError: (error) => {
                    setConfirming(false);
                    toast.error(error.message);
                  },
                })
              }
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </>
        ) : null}
      </Row>
    </li>
  );
}

/** An app's name and the address it returns people to after they sign in, both required. A refusal shows under its field. */
function RegisterAppForm({ onDone }: { onDone: () => void }) {
  const register = useRegisterApp();
  const retryKey = useRetryKey();
  const errorId = useId();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const input = { name: name.trim(), redirectUris: [address.trim()] };
  const ready = input.name !== '' && address.trim() !== '' && !register.isPending;
  const refused = refusedField(register.error, ['name', 'redirectUris'] as const);
  const said = register.error?.message ?? null;
  const edited = () => {
    // The refusal was about what was sent; an edit makes it stale.
    if (register.isError) register.reset();
  };

  async function submit() {
    if (!ready) return;
    const app = await register
      .mutateAsync({ input, idempotencyKey: retryKey.keyFor(JSON.stringify(input)) })
      .catch(() => null);
    if (app === null) return;
    retryKey.done();
    toast.success(`Registered ${app.name}`);
    onDone();
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-xl bg-surface px-4 py-3.5 inset-ring inset-ring-border"
      aria-label="Register app"
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
      <Field label="Name" required error={refused === 'name' ? said : null}>
        <Input
          autoFocus
          autoComplete="off"
          value={name}
          disabled={register.isPending}
          onChange={(event) => {
            edited();
            setName(event.target.value);
          }}
        />
      </Field>
      <Field label="Redirect address" required error={refused === 'redirectUris' ? said : null}>
        <Input
          type="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://app.example.com/signed-in"
          value={address}
          disabled={register.isPending}
          onChange={(event) => {
            edited();
            setAddress(event.target.value);
          }}
        />
      </Field>
      {said !== null && refused === null ? <FieldError id={errorId}>{said}</FieldError> : null}
      <div className="flex items-center gap-2">
        <Button variant="primary" type="submit" disabled={!ready}>
          {register.isPending ? 'Registering…' : 'Register'}
        </Button>
        <Button type="button" variant="ghost" disabled={register.isPending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A value this sign-in may not change, under its name, as a `Field` lays out one it may. */
function Setting({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="flex min-w-0 flex-col gap-1.5">
      <span id={labelId} className="text-label font-medium text-ink-2">
        {label}
      </span>
      <div className="flex h-7.5 min-w-0 items-center gap-1.5 text-label text-ink">{children}</div>
    </div>
  );
}

/** The name, required, saved with Save or Enter. A refusal shows under it. */
function RenameForm({ workspace }: { workspace: Workspace }) {
  const rename = useRenameWorkspace();
  const errorId = useId();
  const [name, setName] = useState(workspace.name);
  const trimmed = name.trim();
  const ready = trimmed !== '' && trimmed !== workspace.name && !rename.isPending;
  const refused = refusedField(rename.error, ['name'] as const);
  const said = rename.error?.message ?? null;

  return (
    <form
      className="flex flex-col gap-3"
      aria-label="Rename"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        rename.mutate(
          { workspaceId: workspace.workspaceId, name: trimmed },
          {
            onSuccess: (renamed) => {
              setName(renamed.name);
              toast.success(`Renamed to ${renamed.name}`);
            },
          },
        );
      }}
    >
      <Field label="Name" required error={refused === 'name' ? said : null}>
        <Input
          autoComplete="off"
          value={name}
          disabled={rename.isPending}
          onChange={(event) => {
            // The refusal was about what was sent; an edit makes it stale.
            if (rename.isError) rename.reset();
            setName(event.target.value);
          }}
        />
      </Field>
      {said !== null && refused === null ? <FieldError id={errorId}>{said}</FieldError> : null}
      <div>
        <Button variant="primary" type="submit" disabled={!ready}>
          {rename.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
