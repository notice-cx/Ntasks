import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { FieldError } from './field';

/**
 * Settings's parts: a section is one tab's content, its title and one line
 * in Text 2 saying what it controls, an action at its end, then its groups.
 * A group is a flat panel of rows, divided by Border; a row is a setting's
 * label on the left and its control on the right, or under the label on a
 * phone.
 */

export function SettingsSection({
  title,
  description,
  icon,
  action,
  children,
}: {
  title: string;
  description: ReactNode;
  /** Drawn before the title, such as the workspace's icon. */
  icon?: ReactNode;
  /** The section's one action, such as New project. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-5" data-settings-section="">
      <header className="flex items-center gap-3">
        {icon}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={titleId} className="m-0 text-heading text-ink">
            {title}
          </h2>
          <p className="m-0 text-label text-ink-2">{description}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** A panel of settings, under a heading in Text 3 when the section holds more than one. */
export function SettingsGroup({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  return (
    <div
      role="group"
      aria-labelledby={title === undefined ? undefined : titleId}
      className={cn('flex flex-col gap-2', className)}
    >
      {title === undefined ? null : (
        <h3 id={titleId} className="m-0 text-meta font-medium text-ink-3">
          {title}
        </h3>
      )}
      <div className="flex flex-col overflow-hidden rounded-xl bg-background inset-ring inset-ring-border [&>*+*]:border-t [&>*+*]:border-border">
        {children}
      </div>
    </div>
  );
}

/**
 * One setting: its label, then its control. `labelFor` names the control's
 * id when it is one field, so the label names it; otherwise the row is a
 * group the label names. A refusal shows under both.
 */
export function SettingsRow({
  label,
  labelFor,
  error = null,
  children,
  className,
}: {
  label: string;
  labelFor?: string;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  const labelId = useId();
  const errorId = useId();
  const labelClass = 'min-w-0 flex-1 text-label font-medium text-ink';
  return (
    <div
      role={labelFor === undefined ? 'group' : undefined}
      aria-labelledby={labelFor === undefined ? labelId : undefined}
      className={cn('flex flex-col gap-2 px-4 py-3', className)}
      data-settings-row=""
    >
      <div className="flex min-h-7.5 items-center gap-4 max-sm:flex-col max-sm:items-stretch max-sm:gap-2">
        {labelFor === undefined ? (
          <span id={labelId} className={labelClass}>
            {label}
          </span>
        ) : (
          <label id={labelId} htmlFor={labelFor} className={labelClass}>
            {label}
          </label>
        )}
        <div className="flex min-w-0 items-center gap-1.5 text-label text-ink sm:max-w-[65%] sm:justify-end">
          {children}
        </div>
      </div>
      {error === null ? null : <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
