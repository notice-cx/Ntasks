import { Plus } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { refusedField } from '../../api/client';
import type { MadeServiceCredential, ServiceCredential, ServiceGrant } from '../../api/types';
import { PageSkeleton, ReadFailed } from '../../components/surface';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { CopyButton } from '../../components/ui/copy-button';
import { Checkbox, Field, FieldError, Input, Select } from '../../components/ui/field';
import { Row, RowAge, RowMeta, RowSpacer, RowTitle } from '../../components/ui/row';
import { SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { useNow } from '../../hooks/useNow';
import { useRetryKey, useTaskProjects } from '../../hooks/useTasks';
import {
  useCreateServiceCredential,
  useRevokeServiceCredential,
  useServiceCredentials,
} from '../../hooks/useWorkspace';
import { ageMs, formatAge } from '../../lib/format';

/** How far a credential reaches into one project; `none` leaves the project out of its grants. */
type Reach = 'none' | ServiceGrant['access'];

const REACH_WORDS: Readonly<Record<Reach, string>> = { none: 'No access', read: 'Read', write: 'Read and change' };

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Settings's Services tab, for an owner: the credentials services such as a
 * NoticeOS installation or a nightly backup sign in with. An owner makes one,
 * with the projects it reaches and whether it backs up or loads the
 * workspace, copies its token while the page shows it, which it does once,
 * and revokes one. A revoked credential stays listed, since it keeps its name.
 */
export function ServicesSection() {
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<MadeServiceCredential | null>(null);
  return (
    <SettingsSection
      title="Services"
      description="A service such as NoticeOS signs in with a credential's token, and reaches only the projects it names."
      action={
        <Button
          variant="primary"
          disabled={making || made !== null}
          onClick={() => setMaking(true)}
          aria-label="New credential"
          className="max-sm:w-9 max-sm:px-0"
        >
          <Plus aria-hidden strokeWidth={2} />
          <span className="max-sm:hidden">New credential</span>
        </Button>
      }
    >
      {made ? <TokenOnce made={made} onDone={() => setMade(null)} /> : null}
      {making ? (
        <NewCredentialForm
          onCancel={() => setMaking(false)}
          onMade={(credential) => {
            setMaking(false);
            setMade(credential);
          }}
        />
      ) : null}
      <CredentialList />
    </SettingsSection>
  );
}

function CredentialList() {
  const services = useServiceCredentials();
  const catalog = useTaskProjects();
  if (services.isError)
    return (
      <ReadFailed
        title="Couldn't load the credentials"
        error={services.error}
        retrying={services.isFetching}
        onRetry={() => void services.refetch()}
      />
    );
  if (services.isPending) return <PageSkeleton shape="list" />;
  if (services.data.length === 0) return <p className="m-0 text-label text-ink-3">No credentials yet.</p>;
  const projectNames = new Map((catalog.data ?? []).map((project) => [project.projectId, project.displayName]));
  const active = services.data.filter((service) => service.revokedAt === null);
  const revoked = services.data.filter((service) => service.revokedAt !== null);
  return (
    <>
      {active.length > 0 ? (
        <SettingsGroup title={counted(active.length, 'credential')}>
          <ul className="m-0 list-none p-0 [&>li:last-child>div]:border-b-0" aria-label="Credentials">
            {active.map((service) => (
              <CredentialRow key={service.id} service={service} projectNames={projectNames} />
            ))}
          </ul>
        </SettingsGroup>
      ) : null}
      {revoked.length > 0 ? (
        <SettingsGroup title={`${revoked.length} revoked`}>
          <ul className="m-0 list-none p-0 [&>li:last-child>div]:border-b-0" aria-label="Revoked credentials">
            {revoked.map((service) => (
              <CredentialRow key={service.id} service={service} projectNames={projectNames} />
            ))}
          </ul>
        </SettingsGroup>
      ) : null}
    </>
  );
}

/** One credential: its name, the projects it reaches, its backup and load choices and its age. Revoke shows while it works. */
function CredentialRow({
  service,
  projectNames,
}: {
  service: ServiceCredential;
  projectNames: ReadonlyMap<string, string>;
}) {
  const revoke = useRevokeServiceCredential();
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  const reaches = service.grants
    .map((grant) => `${projectNames.get(grant.projectId) ?? grant.projectId}: ${REACH_WORDS[grant.access]}`)
    .join(', ');
  const live = service.revokedAt === null;
  return (
    <li>
      <Row data-service-row={service.id} className="ps-4 pe-2">
        <RowTitle>{service.name}</RowTitle>
        {/* The projects give way before the name does. */}
        {reaches ? <RowMeta className="block min-w-0 shrink-[4] truncate">{reaches}</RowMeta> : null}
        <RowSpacer />
        {service.backup ? <Badge>Backup</Badge> : null}
        {service.restore ? <Badge>Load</Badge> : null}
        <RowAge>{formatAge(ageMs(now, service.revokedAt ?? service.createdAt))}</RowAge>
        {live && !confirming ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        ) : null}
        {live && confirming ? (
          <>
            <span className="shrink-0 text-meta text-ink-2 max-sm:hidden">Revoke {service.name}?</span>
            <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={revoke.isPending}
              data-confirm-revoke=""
              onClick={() =>
                revoke.mutate(service.id, {
                  onSuccess: () => toast.success(`Revoked ${service.name}`),
                  onError: (error) => {
                    setConfirming(false);
                    toast.error(error.message);
                  },
                })
              }
            >
              {revoke.isPending ? 'Revoking…' : 'Revoke'}
            </Button>
          </>
        ) : null}
      </Row>
    </li>
  );
}

/**
 * A credential's name, required; each project's reach, none by default; and
 * the backup and load choices. It needs at least one project or one choice.
 * A refusal shows under the name or the projects when it is about one of
 * them.
 */
function NewCredentialForm({
  onCancel,
  onMade,
}: {
  onCancel: () => void;
  onMade: (made: MadeServiceCredential) => void;
}) {
  const create = useCreateServiceCredential();
  const catalog = useTaskProjects();
  const retryKey = useRetryKey();
  const errorId = useId();
  const grantsErrorId = useId();
  const [name, setName] = useState('');
  const [reach, setReach] = useState<Readonly<Record<string, Reach>>>({});
  const [backup, setBackup] = useState(false);
  const [restore, setRestore] = useState(false);
  const projects = catalog.data ?? [];
  const grants = projects.flatMap((project): ServiceGrant[] => {
    const access = reach[project.projectId] ?? 'none';
    return access === 'none' ? [] : [{ projectId: project.projectId, access }];
  });
  const input = { name: name.trim(), grants, backup, restore };
  const ready = input.name !== '' && (grants.length > 0 || backup || restore) && !create.isPending;
  const refused = refusedField(create.error, ['name', 'grants'] as const);
  const said = create.error?.message ?? null;
  const edited = () => {
    // The refusal was about what was sent; an edit makes it stale.
    if (create.isError) create.reset();
  };

  async function submit() {
    if (!ready) return;
    const made = await create
      .mutateAsync({ input, idempotencyKey: retryKey.keyFor(JSON.stringify(input)) })
      .catch(() => null);
    if (made === null) return;
    retryKey.done();
    onMade(made);
  }

  return (
    <form
      className="flex flex-col gap-4 rounded-xl bg-surface px-4 py-3.5 inset-ring inset-ring-border"
      aria-label="New credential"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onCancel();
      }}
    >
      <Field label="Name" required error={refused === 'name' ? said : null}>
        <Input
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="noticeos"
          value={name}
          disabled={create.isPending}
          onChange={(event) => {
            edited();
            setName(event.target.value);
          }}
        />
      </Field>
      <fieldset
        className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
        aria-describedby={refused === 'grants' ? grantsErrorId : undefined}
      >
        <legend className="mb-1.5 p-0 text-label font-medium text-ink-2">Projects</legend>
        {catalog.isPending ? (
          <PageSkeleton shape="list" />
        ) : projects.length === 0 ? (
          <p className="m-0 text-meta text-ink-3">No projects yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {projects.map((project) => (
              <li key={project.projectId} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-label text-ink">{project.displayName}</span>
                <Select
                  className="w-40"
                  aria-label={`${project.displayName} access`}
                  value={reach[project.projectId] ?? 'none'}
                  disabled={create.isPending}
                  onChange={(event) => {
                    edited();
                    const access = event.target.value;
                    setReach((known) => ({
                      ...known,
                      [project.projectId]: access === 'read' || access === 'write' ? access : 'none',
                    }));
                  }}
                >
                  {(['none', 'read', 'write'] as const).map((value) => (
                    <option key={value} value={value}>
                      {REACH_WORDS[value]}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        )}
        {refused === 'grants' && said !== null ? <FieldError id={grantsErrorId}>{said}</FieldError> : null}
      </fieldset>
      <div className="flex flex-col gap-2">
        <Checkbox
          label="Back up every project"
          checked={backup}
          disabled={create.isPending}
          onChange={(checked) => {
            edited();
            setBackup(checked);
          }}
        />
        <Checkbox
          label="Load tasks into this workspace while it is empty"
          checked={restore}
          disabled={create.isPending}
          onChange={(checked) => {
            edited();
            setRestore(checked);
          }}
        />
      </div>
      {said !== null && refused === null ? <FieldError id={errorId}>{said}</FieldError> : null}
      <div className="flex items-center gap-2">
        <Button variant="primary" type="submit" disabled={!ready}>
          {create.isPending ? 'Making…' : 'Make credential'}
        </Button>
        <Button type="button" variant="ghost" disabled={create.isPending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The token of a credential just made, with a copy button. Done hides it, and no page shows it again. */
function TokenOnce({ made, onDone }: { made: MadeServiceCredential; onDone: () => void }) {
  const token = useRef<HTMLElement>(null);
  return (
    <section
      aria-label={`Token for ${made.name}`}
      className="flex flex-col gap-3 rounded-xl bg-surface px-4 py-3.5 inset-ring inset-ring-border"
      data-service-token=""
    >
      <p className="m-0 text-label text-ink">Copy the token for {made.name} now. It is not shown again.</p>
      <div className="flex min-w-0 items-center gap-1.5 rounded-md bg-background py-1 ps-2.25 pe-1 inset-ring inset-ring-border">
        <code ref={token} className="min-w-0 flex-1 font-mono text-code break-all text-ink">
          {made.token}
        </code>
        <CopyButton label="Copy token" text={() => made.token} target={token} />
      </div>
      <div>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}
