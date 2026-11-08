import { Copy } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { refusedField } from '@/api/client';
import type { Workspace } from '@/api/types';
import { Button, IconButton } from '@/components/ui/button';
import { Field, FieldError, Input } from '@/components/ui/field';
import { TopBar } from '@/components/ui/shell';
import { WorkspaceIcon } from '@/components/ui/symbols';
import { useRenameWorkspace, useWorkspace } from '@/hooks/useWorkspace';
import { copyText } from '@/lib/clipboard';

/**
 * The open workspace's name and id. An owner renames it; anyone else reads
 * the name. The name is only shown: the API and agents name a workspace by
 * its id, which never changes.
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
      </div>
    </>
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
