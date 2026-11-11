import { Copy } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { refusedField } from '../api/client';
import type { ConnectedApp, GitHubAppStart, GitHubWebhook, Workspace } from '../api/types';
import { PageSkeleton, ReadFailed } from '../components/surface';
import { Button, IconButton } from '../components/ui/button';
import { TabLinks } from '../components/ui/choice';
import { Field, FieldError, Input, Select, Textarea } from '../components/ui/field';
import { Row, RowMeta, RowSpacer, RowTitle } from '../components/ui/row';
import { SettingsGroup, SettingsRow, SettingsSection, settingsErrorId } from '../components/ui/settings';
import { TopBar } from '../components/ui/shell';
import { WorkspaceIcon } from '../components/ui/symbols';
import { useMedia } from '../hooks/useMedia';
import { useRetryKey } from '../hooks/useTasks';
import {
  useAccount,
  useApps,
  useConnectGitHub,
  useDisconnectGitHub,
  useGitHubWebhook,
  useRegisterApp,
  useRemoveApp,
  useRemoveGitHubWebhook,
  useRenameWorkspace,
  useRepositories,
  useRevokeApp,
  useSaveGitHubWebhook,
  useSetDeployCheck,
  useSetRepository,
  useSetTimeZone,
  useWorkspace,
} from '../hooks/useWorkspace';
import { copyText } from '../lib/clipboard';
import { browserTimeZone, timeZoneNames } from '../lib/dates';
import { usePageTitle } from '../lib/page-title';
import { usePaths } from '../lib/paths';
import { MembersSection } from './settings/MembersSection';
import { ProjectsSection } from './settings/ProjectsSection';
import { ServicesSection } from './settings/ServicesSection';

/** Settings's tabs, in order: the workspace's first, then the person's own. An owner alone sees Members, GitHub and
 * Services. */
const TABS = [
  { key: 'workspace', label: 'Workspace', owner: false },
  { key: 'projects', label: 'Projects', owner: false },
  { key: 'members', label: 'Members', owner: true },
  { key: 'github', label: 'GitHub', owner: true },
  { key: 'apps', label: 'Apps', owner: false },
  { key: 'services', label: 'Services', owner: true },
  { key: 'you', label: 'You', owner: false },
] as const;
type Tab = (typeof TABS)[number]['key'];

/** Below 64rem the top bar has no room for every tab, so they take a row of their own under it. */
const NARROW = '(width < 64rem)';

/**
 * Settings: one tab at a time, each at its own address under the top bar's
 * tabs. Workspace is the workspace's name and ID; Projects and Members its
 * projects and people; GitHub how merges and deploys reach it; Apps the apps
 * that act for whoever signs in to them; Services the credentials services
 * sign in with; You the person's own settings in every workspace.
 * `/settings` opens the first tab, as does a tab this
 * sign-in may not open, except that GitHub's return from an installation,
 * which names `installation_id` or `github`, opens the GitHub tab.
 */
export default function SettingsRoute() {
  const { tab } = useParams();
  const [params] = useSearchParams();
  const { workspace } = useWorkspace();
  const paths = usePaths();
  const narrow = useMedia(NARROW);
  const owner = workspace.role === 'owner';
  const tabs = TABS.filter((entry) => owner || !entry.owner);
  const current = tabs.find((entry) => entry.key === tab);
  usePageTitle(current?.label ?? 'Settings', current === undefined ? null : 'Settings');
  if (current === undefined) {
    const fromGitHub = owner && tab === undefined && (params.has('installation_id') || params.has('github'));
    const to = paths.settingsTab(fromGitHub ? 'github' : tabs[0]!.key);
    return <Navigate to={{ pathname: to, search: fromGitHub ? `?${params}` : '' }} replace />;
  }

  const tabLinks = (
    <TabLinks
      label="Settings"
      items={tabs.map((entry) => ({
        to: paths.settingsTab(entry.key),
        label: entry.label,
        current: entry.key === current.key,
      }))}
    />
  );
  return (
    <>
      <TopBar title="Settings">{narrow ? null : tabLinks}</TopBar>
      {narrow ? (
        <div
          className="overflow-x-auto border-b border-border px-4 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-narrow-views=""
        >
          {tabLinks}
        </div>
      ) : null}
      <div className="flex w-full max-w-180 flex-col px-6 py-6 max-sm:px-4" data-settings-tab={current.key}>
        <TabContent tab={current.key} workspace={workspace} />
      </div>
    </>
  );
}

function TabContent({ tab, workspace }: { tab: Tab; workspace: Workspace }) {
  switch (tab) {
    case 'you':
      return <YouSection />;
    case 'workspace':
      return <WorkspaceSection workspace={workspace} />;
    case 'projects':
      return <ProjectsSection />;
    case 'members':
      return <MembersSection />;
    case 'github':
      return <GitHubWebhookSection />;
    case 'apps':
      return <ConnectedApps owner={workspace.role === 'owner'} />;
    case 'services':
      return <ServicesSection />;
  }
}

/** The person's own settings, which apply in every workspace. */
function YouSection() {
  const account = useAccount(true);
  return (
    <SettingsSection title="You" description="Your own settings, in every workspace.">
      <SettingsGroup>
        <SettingsRow label="Name">
          <span className="min-w-0 truncate">{account.data?.name ?? ''}</span>
        </SettingsRow>
        <TimeZoneSetting />
      </SettingsGroup>
    </SettingsSection>
  );
}

/** The workspace's name and ID. An owner renames it; anyone else reads the name. The API and agents name a
 * workspace by its ID, which never changes. */
function WorkspaceSection({ workspace }: { workspace: Workspace }) {
  return (
    <SettingsSection
      title="Workspace"
      description="People see the name; agents and the API use the ID."
      icon={<WorkspaceIcon workspaceId={workspace.workspaceId} name={workspace.name} size={32} />}
    >
      <SettingsGroup>
        {workspace.role === 'owner' ? (
          <RenameRow workspace={workspace} />
        ) : (
          <SettingsRow label="Name">
            <span className="min-w-0 truncate">{workspace.name}</span>
          </SettingsRow>
        )}
        <SettingsRow label="ID">
          <code className="min-w-0 truncate font-mono text-code text-ink">{workspace.workspaceId}</code>
          <IconButton
            size="sm"
            label="Copy ID"
            icon={<Copy aria-hidden />}
            onClick={() => void copyText(workspace.workspaceId, 'the ID')}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
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
      <SettingsGroup>
        <ul className="m-0 list-none p-0 [&>li:last-child>div]:border-b-0" aria-label="Connected apps">
          {apps.data.map((app) => (
            <AppRow key={app.clientId} app={app} owner={owner} />
          ))}
        </ul>
      </SettingsGroup>
    );
  return (
    <SettingsSection
      title="Connected apps"
      description="An app here acts as whoever signs in to it, in this workspace only."
      action={
        owner ? (
          <Button disabled={registering} onClick={() => setRegistering(true)}>
            Register app
          </Button>
        ) : undefined
      }
    >
      {owner && registering ? <RegisterAppForm onDone={() => setRegistering(false)} /> : null}
      {list}
    </SettingsSection>
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
      <Row data-app-row={app.clientId} className="ps-4 pe-2">
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
    <SettingsSection
      title="GitHub"
      description="GitHub moves a closed task to Merged when its pull request merges, and to Live when its deploy passes."
    >
      {body}
    </SettingsSection>
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
    <div className="flex flex-col gap-5">
      {retry ? (
        <p role="status" className="m-0 text-label text-ink">
          GitHub didn't finish connecting. Press Connect GitHub again.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-3 inset-ring inset-ring-border">
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
      <ByHand open={github.updatedAt !== null}>
        {/* A save gives the form the saved values to start from again. */}
        <GitHubWebhookForm key={github.updatedAt ?? 'none'} webhook={github} />
      </ByHand>
      {/* A webhook set up by hand moves tasks too, and the repositories it showed stay after the app is disconnected. */}
      <MergesGoLive hideEmpty />
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
    <div className="flex flex-col gap-5">
      <SettingsGroup>
        <SettingsRow label="App">
          <a href={app.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-ink underline">
            {app.slug}
          </a>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Installed on">
        <div data-github-installations="">
          {github.installations.length === 0 ? (
            <p className="m-0 px-4 py-3 text-label text-ink-3">No account yet.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {github.installations.map((installation) => (
                <li key={installation.installationId}>
                  <Row className="ps-4 pe-2">
                    <RowTitle>{installation.account}</RowTitle>
                    <RowMeta>{installation.accountType === 'Organization' ? 'Organization' : 'Account'}</RowMeta>
                  </Row>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 px-4 py-3">
            <Button asChild size="sm" variant="primary">
              <a href={app.accountInstallUrl}>Install on your account</a>
            </Button>
            <Button asChild size="sm">
              <a href={app.installUrl}>Install on an organization</a>
            </Button>
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup title="Deploys">
        <div data-github-deploys="">
          {github.detected.length === 0 ? (
            <p className="m-0 px-4 py-3 text-label text-ink-3">
              None seen yet. A passing Workers Builds check or a production deployment shows here.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 px-4 py-3">
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
      </SettingsGroup>
      <MergesGoLive />
      {/* A webhook set up by hand works beside the app: its owner can add, change or remove one at any time. */}
      <ByHand open={false}>
        <GitHubWebhookForm key={github.updatedAt ?? 'none'} webhook={github} />
      </ByHand>
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
          <Button type="button" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The repositories whose changes moved a task, each with a box that says its
 * merges go live, for a repository with no deploy. Ticking one also moves its
 * tasks at Merged to Live.
 */
function MergesGoLive({ hideEmpty = false }: { hideEmpty?: boolean }) {
  const repositories = useRepositories();
  const set = useSetRepository();
  if (repositories.isPending || (hideEmpty && repositories.data?.length === 0)) return null;
  return (
    <SettingsGroup title="Merges go live">
      <div data-github-repositories="">
        {repositories.isError ? (
          <ReadFailed
            title="Couldn't load the repositories"
            error={repositories.error}
            retrying={repositories.isFetching}
            onRetry={() => void repositories.refetch()}
          />
        ) : repositories.data.length === 0 ? (
          <p className="m-0 px-4 py-3 text-label text-ink-3">
            None seen yet. A repository shows here once a merge in it moves a task.
          </p>
        ) : (
          <>
            <p className="m-0 px-4 pt-3 text-meta text-ink-2">
              Tick a repository with no deploy: its merged tasks then show as Live.
            </p>
            <ul className="m-0 flex list-none flex-col gap-2 px-4 py-3">
              {repositories.data.map(({ repository, mergesLive }) => (
                <li key={repository}>
                  <label className="flex items-center gap-2 text-label text-ink">
                    <input
                      type="checkbox"
                      className="size-[15px] accent-accent"
                      checked={
                        set.isPending && set.variables.repository === repository ? set.variables.mergesLive : mergesLive
                      }
                      disabled={set.isPending}
                      aria-label={`Merges in ${repository} go live`}
                      onChange={(event) =>
                        set.mutate(
                          { repository, mergesLive: event.target.checked },
                          {
                            onSuccess: ({ moved }) => {
                              if (moved.length > 0)
                                toast.success(
                                  `Moved ${moved.length} merged ${moved.length === 1 ? 'task' : 'tasks'} of ${repository} to Live`,
                                );
                            },
                            onError: (error) => toast.error(error.message),
                          },
                        )
                      }
                    />
                    <span className="min-w-0 truncate">{repository}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </SettingsGroup>
  );
}

/** The GitHub webhook set up by hand, folded under its own heading on a panel. */
function ByHand({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <details className="group rounded-xl px-4 py-3 inset-ring inset-ring-border" open={open}>
      <summary className="cursor-pointer text-label font-medium text-ink">Set up by hand</summary>
      <div className="pt-3">{children}</div>
    </details>
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

/**
 * The time zone every date is shown in, for the person signed in in every
 * workspace: their browser's until they choose one. A choice is saved with
 * their account as soon as it is picked.
 */
function TimeZoneSetting() {
  const account = useAccount(true);
  const save = useSetTimeZone();
  const id = useId();
  const zones = useMemo(timeZoneNames, []);
  const browser = browserTimeZone();
  const chosen = account.data?.timeZone ?? '';
  const failed = save.error === null ? null : save.error.message || 'The time zone was not saved.';
  return (
    <SettingsRow label="Time zone" labelFor={id} error={failed}>
      <Select
        id={id}
        className="w-72 max-sm:w-full"
        value={chosen}
        disabled={account.data === undefined || save.isPending}
        aria-invalid={failed === null ? undefined : true}
        aria-describedby={failed === null ? undefined : settingsErrorId(id)}
        onChange={(event) => {
          const zone = event.target.value === '' ? null : event.target.value;
          save.mutate(zone, { onSuccess: () => toast.success(`Dates now show in ${zoneName(zone ?? browser)}`) });
        }}
        data-time-zone=""
      >
        <option value="">Your browser’s: {zoneName(browser)}</option>
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zoneName(zone)}
          </option>
        ))}
      </Select>
    </SettingsRow>
  );
}

/** A time zone's IANA name as a person reads it: `America/Los Angeles`. */
const zoneName = (zone: string) => zone.replaceAll('_', ' ');

/** The workspace's name, required, saved with Save or Enter. A refusal shows under it. */
function RenameRow({ workspace }: { workspace: Workspace }) {
  const rename = useRenameWorkspace();
  const id = useId();
  const [name, setName] = useState(workspace.name);
  const trimmed = name.trim();
  const ready = trimmed !== '' && trimmed !== workspace.name && !rename.isPending;
  const said = rename.error?.message ?? null;

  return (
    <form
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
      <SettingsRow label="Name" labelFor={id} error={said}>
        <Input
          boxClassName="w-64 max-sm:w-full"
          id={id}
          required
          aria-required
          aria-invalid={said === null ? undefined : true}
          aria-describedby={said === null ? undefined : settingsErrorId(id)}
          autoComplete="off"
          value={name}
          disabled={rename.isPending}
          onChange={(event) => {
            // The refusal was about what was sent; an edit makes it stale.
            if (rename.isError) rename.reset();
            setName(event.target.value);
          }}
        />
        <Button variant="primary" type="submit" disabled={!ready}>
          {rename.isPending ? 'Saving…' : 'Save'}
        </Button>
      </SettingsRow>
    </form>
  );
}
