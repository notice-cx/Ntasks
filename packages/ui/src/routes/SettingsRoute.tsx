import { Copy } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { refusedField } from '../api/client';
import type { ConnectedApp, GitHubAppStart, GitHubWebhook, Workspace } from '../api/types';
import { PageSkeleton, ReadFailed } from '../components/surface';
import { Button, IconButton } from '../components/ui/button';
import { Field, FieldError, Input, Textarea } from '../components/ui/field';
import { Row, RowMeta, RowSpacer, RowTitle } from '../components/ui/row';
import { TopBar } from '../components/ui/shell';
import { WorkspaceIcon } from '../components/ui/symbols';
import { useRetryKey } from '../hooks/useTasks';
import {
  useApps,
  useConnectGitHub,
  useDisconnectGitHub,
  useGitHubWebhook,
  useRegisterApp,
  useRemoveApp,
  useRemoveGitHubWebhook,
  useRenameWorkspace,
  useRevokeApp,
  useSaveGitHubWebhook,
  useSetDeployCheck,
  useWorkspace,
} from '../hooks/useWorkspace';
import { copyText } from '../lib/clipboard';

/**
 * The open workspace's name and id, its connected apps, and for an owner its
 * GitHub webhook. An owner renames it; anyone else reads the name. The name
 * is only shown: the API and agents name a workspace by its id, which never
 * changes.
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
        {workspace.role === 'owner' ? <GitHubWebhookSection /> : null}
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

/**
 * GitHub for the workspace, for its owners. Connect GitHub makes the
 * workspace's GitHub App; installed on an account, it tells Ntasks when that
 * account's pull requests merge and their deploys pass, so closed tasks move
 * to Merged and Live without an agent reporting it. A webhook can also be set
 * up by hand.
 */
function GitHubWebhookSection() {
  const github = useGitHubWebhook();
  const [params] = useSearchParams();
  let body: ReactNode;
  if (github.isError)
    body = (
      <ReadFailed
        title="Couldn't load GitHub"
        error={github.error}
        retrying={github.isFetching}
        onRetry={() => void github.refetch()}
      />
    );
  else if (github.isPending) body = <PageSkeleton shape="page" />;
  else if (github.data.app !== null) body = <GitHubConnected github={github.data} />;
  else body = <GitHubConnect github={github.data} retry={params.get('github') === 'retry'} />;
  return (
    <section aria-label="GitHub" className="flex flex-col gap-3 pt-2">
      <h2 className="m-0 text-label font-medium text-ink">GitHub</h2>
      <p className="m-0 text-label text-ink-2">
        GitHub moves a closed task to Merged when its pull request merges, and to Live when its deploy passes.
      </p>
      {body}
    </section>
  );
}

/** Posts the manifest to GitHub from this page, as GitHub's manifest flow takes it: a form, never a fetch. */
function postToGitHub({ action, manifest }: GitHubAppStart): void {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = manifest;
  form.append(field);
  document.body.append(form);
  form.submit();
}

/** Before the app is made: Connect GitHub, and the webhook set up by hand under its own heading. */
function GitHubConnect({ github, retry }: { github: GitHubWebhook; retry: boolean }) {
  const connect = useConnectGitHub();
  return (
    <div className="flex flex-col gap-3">
      {retry ? (
        <p role="status" className="m-0 text-label text-ink">
          GitHub didn't finish connecting. Press Connect GitHub again.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={connect.isPending}
          onClick={() =>
            connect.mutate(undefined, {
              onSuccess: postToGitHub,
              onError: (error) => toast.error(error.message),
            })
          }
        >
          {connect.isPending ? 'Connecting…' : 'Connect GitHub'}
        </Button>
        <p className="m-0 text-meta text-ink-2">
          GitHub makes an app for this workspace. Then install it on your account and your organizations.
        </p>
      </div>
      <details className="group" open={github.updatedAt !== null}>
        <summary className="cursor-pointer text-label text-ink-2">Set up by hand</summary>
        <div className="pt-3">
          {/* A save gives the form the saved values to start from again. */}
          <GitHubWebhookForm key={github.updatedAt ?? 'none'} webhook={github} />
        </div>
      </details>
    </div>
  );
}

/** After the app is made: where it is installed, the links that install it, the deploys it detected, and Disconnect. */
function GitHubConnected({ github }: { github: GitHubWebhook }) {
  const app = github.app!;
  const disconnect = useDisconnectGitHub();
  const setCheck = useSetDeployCheck();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <Setting label="App">
        <a href={app.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-ink underline">
          {app.slug}
        </a>
      </Setting>
      <div className="flex flex-col gap-1.5" data-github-installations="">
        <span className="text-label font-medium text-ink-2">Installed on</span>
        {github.installations.length === 0 ? (
          <p className="m-0 text-label text-ink-3">No account yet.</p>
        ) : (
          <ul className="m-0 list-none overflow-hidden rounded-lg p-0 inset-ring inset-ring-border [&>li:last-child>div]:border-b-0">
            {github.installations.map((installation) => (
              <li key={installation.installationId}>
                <Row className="ps-3 pe-2">
                  <RowTitle>{installation.account}</RowTitle>
                  <RowMeta>{installation.accountType === 'Organization' ? 'Organization' : 'Account'}</RowMeta>
                </Row>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2 pt-1.5">
          <Button asChild size="sm" variant="primary">
            <a href={app.accountInstallUrl}>Install on your account</a>
          </Button>
          <Button asChild size="sm">
            <a href={app.installUrl}>Install on an organization</a>
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5" data-github-deploys="">
        <span className="text-label font-medium text-ink-2">Deploys</span>
        {github.detected.length === 0 ? (
          <p className="m-0 text-label text-ink-3">
            None seen yet. A passing Workers Builds check or a production deployment shows here.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {github.detected.map((check) => (
              <li key={check.name}>
                <label className="flex items-center gap-2 text-label text-ink">
                  <input
                    type="checkbox"
                    className="size-[15px] accent-accent"
                    checked={
                      setCheck.isPending && setCheck.variables.name === check.name ? setCheck.variables.on : check.on
                    }
                    disabled={setCheck.isPending}
                    aria-label={`${check.name} counts as a deploy`}
                    onChange={(event) =>
                      setCheck.mutate(
                        { name: check.name, on: event.target.checked },
                        { onError: (error) => toast.error(error.message) },
                      )
                    }
                  />
                  <span className="min-w-0 truncate">{check.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="text-meta text-ink-2">The app's events are refused after this.</span>
            <Button type="button" variant="ghost" disabled={disconnect.isPending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={disconnect.isPending}
              data-confirm-disconnect=""
              onClick={() =>
                disconnect.mutate(undefined, {
                  onSuccess: () => toast.success('Disconnected GitHub. Delete the app on its GitHub page too.'),
                  onError: (error) => {
                    setConfirming(false);
                    toast.error(error.message);
                  },
                })
              }
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </>
        ) : (
          <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        )}
      </div>
      {/* A webhook saved by hand still sends deliveries, so its owner can still change or remove it. */}
      {github.updatedAt !== null ? (
        <details className="group">
          <summary className="cursor-pointer text-label text-ink-2">Set up by hand</summary>
          <div className="pt-3">
            <GitHubWebhookForm key={github.updatedAt} webhook={github} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** A new webhook secret: 32 random bytes as base64url, 43 characters. */
function newSecret(): string {
  let binary = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** The payload URL to copy into GitHub, the secret, and the deploy checks, one per line. A refusal shows under its field. */
function GitHubWebhookForm({ webhook }: { webhook: GitHubWebhook }) {
  const save = useSaveGitHubWebhook();
  const remove = useRemoveGitHubWebhook();
  const errorId = useId();
  const [secret, setSecret] = useState('');
  const [checks, setChecks] = useState(webhook.deployChecks.join('\n'));
  const [confirming, setConfirming] = useState(false);
  const deployChecks = checks
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const checksChanged = deployChecks.join('\n') !== webhook.deployChecks.join('\n');
  const ready = !save.isPending && (secret !== '' || (webhook.secretSaved && checksChanged));
  const refused = refusedField(save.error, ['secret', 'deployChecks'] as const);
  const said = save.error?.message ?? null;
  const edited = () => {
    // The refusal was about what was sent; an edit makes it stale.
    if (save.isError) save.reset();
  };

  return (
    <form
      className="flex flex-col gap-3"
      aria-label="GitHub webhook"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        save.mutate(
          { ...(secret === '' ? {} : { secret }), deployChecks },
          { onSuccess: () => toast.success('Saved the GitHub webhook') },
        );
      }}
    >
      <Setting label="Payload URL">
        <code className="min-w-0 truncate font-mono text-code text-ink">{webhook.url}</code>
        <IconButton
          size="sm"
          label="Copy payload URL"
          icon={<Copy aria-hidden />}
          onClick={() => void copyText(webhook.url, 'the payload URL')}
        />
      </Setting>
      <Field label="Secret" required={!webhook.secretSaved} error={refused === 'secret' ? said : null}>
        <Input
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={webhook.secretSaved ? 'Saved' : undefined}
          value={secret}
          disabled={save.isPending}
          onChange={(event) => {
            edited();
            setSecret(event.target.value);
          }}
          end={
            secret === '' ? undefined : (
              <IconButton
                size="sm"
                label="Copy secret"
                icon={<Copy aria-hidden />}
                onClick={() => void copyText(secret, 'the secret')}
              />
            )
          }
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={save.isPending}
          onClick={() => {
            edited();
            setSecret(newSecret());
          }}
        >
          Make a secret
        </Button>
        <p className="m-0 text-meta text-ink-2">
          {webhook.secretSaved
            ? 'A new secret replaces the saved one. Enter it in GitHub too.'
            : "Enter the same secret in GitHub's webhook form."}
        </p>
      </div>
      <Field label="Deploy checks" error={refused === 'deployChecks' ? said : null}>
        <Textarea
          rows={3}
          spellCheck={false}
          placeholder="Workers Builds: my-app"
          value={checks}
          disabled={save.isPending}
          onChange={(event) => {
            edited();
            setChecks(event.target.value);
          }}
        />
      </Field>
      <p className="m-0 text-meta text-ink-2">
        One per line: a check run or deployment environment whose success means the change is live.
      </p>
      {said !== null && refused === null ? <FieldError id={errorId}>{said}</FieldError> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" type="submit" disabled={!ready}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {webhook.updatedAt !== null && !confirming ? (
          <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        ) : null}
        {confirming ? (
          <>
            <span className="text-meta text-ink-2">GitHub's deliveries are refused after this.</span>
            <Button type="button" variant="ghost" disabled={remove.isPending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={remove.isPending}
              data-confirm-remove=""
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => toast.success('Removed the GitHub webhook'),
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
