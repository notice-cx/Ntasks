import { UserPlus } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { refusedField } from '../../api/client';
import type { WorkspaceInvitation, WorkspaceMember, WorkspaceRole } from '../../api/types';
import { PageSkeleton, ReadFailed } from '../../components/surface';
import { Avatar } from '../../components/ui/avatar';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Field, FieldError, Input, Select } from '../../components/ui/field';
import { Kbd } from '../../components/ui/kbd';
import { Row, RowAge, RowMeta, RowSpacer, RowTitle } from '../../components/ui/row';
import { SettingsGroup, SettingsSection } from '../../components/ui/settings';
import { useNow } from '../../hooks/useNow';
import { useShortcut } from '../../hooks/useShortcut';
import { useRetryKey } from '../../hooks/useTasks';
import { useInvite, useMembers, useRemoveMember, useRevokeInvitation } from '../../hooks/useWorkspace';
import { ageMs, formatAge } from '../../lib/format';

const ROLE_WORDS: Readonly<Record<WorkspaceRole, string>> = { owner: 'Owner', member: 'Member' };

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Settings's Members tab, for an owner: the workspace's members and pending
 * invitations. An owner invites a GitHub account (`I`), revokes an
 * invitation and removes a member. Settings shows the tab to owners alone.
 */
export function MembersSection() {
  const [inviting, setInviting] = useState(false);
  useShortcut('i', () => setInviting(true), !inviting);
  return (
    <SettingsSection
      title="Members"
      description="The people who use this workspace, and the GitHub accounts invited to it."
      action={
        <Button
          variant="primary"
          disabled={inviting}
          onClick={() => setInviting(true)}
          aria-label="Invite"
          aria-keyshortcuts="I"
          className="max-sm:w-9 max-sm:px-0"
        >
          <UserPlus aria-hidden />
          <span className="max-sm:hidden">Invite</span>
          <Kbd className="max-sm:hidden">I</Kbd>
        </Button>
      }
    >
      {inviting ? <InviteForm onDone={() => setInviting(false)} /> : null}
      <MemberList />
    </SettingsSection>
  );
}

function MemberList() {
  const members = useMembers(true);
  if (members.isError)
    return (
      <ReadFailed
        title="Couldn't load the members"
        error={members.error}
        retrying={members.isFetching}
        onRetry={() => void members.refetch()}
      />
    );
  if (members.isPending) return <PageSkeleton shape="list" />;
  const { members: people, invitations } = members.data;
  return (
    <>
      <SettingsGroup title={counted(people.length, 'member')}>
        <ul className="m-0 list-none p-0 [&>li:last-child>div]:border-b-0" aria-label="Members">
          {people.map((member) => (
            <MemberRow key={member.userId} member={member} />
          ))}
        </ul>
      </SettingsGroup>
      {invitations.length > 0 ? (
        <SettingsGroup title={counted(invitations.length, 'invitation')}>
          <ul className="m-0 list-none p-0 [&>li:last-child>div]:border-b-0" aria-label="Invitations">
            {invitations.map((invitation) => (
              <InvitationRow key={invitation.invitationId} invitation={invitation} />
            ))}
          </ul>
        </SettingsGroup>
      ) : null}
    </>
  );
}

function MemberRow({ member }: { member: WorkspaceMember }) {
  const remove = useRemoveMember();
  const [confirming, setConfirming] = useState(false);
  const end: ReactNode = confirming ? (
    <>
      <span className="shrink-0 text-meta text-ink-2 max-sm:hidden">Remove {member.name}?</span>
      <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      <Button
        size="sm"
        disabled={remove.isPending}
        data-confirm-remove=""
        onClick={() =>
          remove.mutate(member.userId, {
            onSuccess: () => toast.success(`Removed ${member.name}`),
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
  ) : (
    <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
      Remove
    </Button>
  );
  return (
    <li>
      <Row data-member-row={member.userId} className="ps-4 pe-2">
        <Avatar name={member.name} size={20} decorative />
        <RowTitle>{member.name}</RowTitle>
        {member.githubLogin ? <RowMeta>{member.githubLogin}</RowMeta> : null}
        <RowSpacer />
        <Badge>{ROLE_WORDS[member.role]}</Badge>
        {end}
      </Row>
    </li>
  );
}

function InvitationRow({ invitation }: { invitation: WorkspaceInvitation }) {
  const revoke = useRevokeInvitation();
  const now = useNow();
  return (
    <li>
      <Row data-invitation-row={invitation.invitationId} className="ps-4 pe-2">
        <UserPlus aria-hidden size={14} className="shrink-0 text-ink-3" />
        <RowTitle>{invitation.githubLogin}</RowTitle>
        <RowSpacer />
        <Badge>{ROLE_WORDS[invitation.role]}</Badge>
        {invitation.createdAt ? <RowAge>{formatAge(ageMs(now, invitation.createdAt))}</RowAge> : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={revoke.isPending}
          onClick={() =>
            revoke.mutate(invitation.invitationId, {
              onSuccess: () => toast.success(`Revoked the invitation for ${invitation.githubLogin}`),
              onError: (error) => toast.error(error.message),
            })
          }
        >
          {revoke.isPending ? 'Revoking…' : 'Revoke'}
        </Button>
      </Row>
    </li>
  );
}

/** A GitHub username, required, and the role it joins with. A refusal shows under the username. */
function InviteForm({ onDone }: { onDone: () => void }) {
  const invite = useInvite();
  const retryKey = useRetryKey();
  const errorId = useId();
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('member');
  // A username copied with its @ is still the username.
  const githubLogin = login.trim().replace(/^@/u, '');
  const ready = githubLogin !== '' && !invite.isPending;
  const refused = refusedField(invite.error, ['githubLogin'] as const);
  const said = invite.error?.message ?? null;

  async function submit() {
    if (!ready) return;
    const input = { githubLogin, role };
    const sent = await invite.mutateAsync({ input, idempotencyKey: retryKey.keyFor(JSON.stringify(input)) }).then(
      () => true,
      () => false,
    );
    if (!sent) return;
    retryKey.done();
    toast.success(`Invited ${githubLogin}`);
    onDone();
  }

  return (
    <div>
      <form
        className="flex flex-col gap-3 rounded-xl bg-surface px-4 py-3.5 inset-ring inset-ring-border"
        aria-label="Invite"
        data-invite=""
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
        <div className="grid grid-cols-[minmax(0,1fr)_160px] items-start gap-2 max-sm:grid-cols-1">
          <Field label="GitHub username" required error={refused === 'githubLogin' ? said : null}>
            <Input
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={login}
              disabled={invite.isPending}
              onChange={(event) => {
                // The refusal was about what was sent; an edit makes it stale.
                if (invite.isError) invite.reset();
                setLogin(event.target.value);
              }}
            />
          </Field>
          <Field label="Role">
            <Select
              value={role}
              disabled={invite.isPending}
              onChange={(event) => {
                if (invite.isError) invite.reset();
                setRole(event.target.value === 'owner' ? 'owner' : 'member');
              }}
            >
              <option value="member">{ROLE_WORDS.member}</option>
              <option value="owner">{ROLE_WORDS.owner}</option>
            </Select>
          </Field>
        </div>
        {said !== null && refused === null ? <FieldError id={errorId}>{said}</FieldError> : null}
        <div className="flex items-center gap-2">
          <Button variant="primary" type="submit" disabled={!ready}>
            {invite.isPending ? 'Inviting…' : 'Invite'}
          </Button>
          <Button type="button" variant="ghost" disabled={invite.isPending} onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
