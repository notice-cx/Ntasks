import { CircleAlert } from 'lucide-react';
import { createContext, useContext, useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Text entry. A field is 30 px tall (36 px on a touch screen), Background
 * with a Border ring, 13 px text and a Text 3 placeholder. Focus rings it in
 * Accent with a 3 px Accent soft halo. A field the server refused rings in
 * Text and names the problem under it.
 */
const boxClass = cn(
  'flex w-full min-w-0 items-center gap-2 rounded-md bg-background text-label text-ink-3 inset-ring inset-ring-border',
  'transition-[box-shadow] duration-120 ease-out',
  'focus-within:inset-ring-accent focus-within:ring-3 focus-within:ring-accent-soft',
  'has-[[aria-invalid=true]]:inset-ring-ink',
  'has-disabled:opacity-45',
);

const controlClass =
  'min-w-0 flex-1 border-0 bg-transparent p-0 text-label text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed';

interface FieldWiring {
  id: string;
  required: boolean;
  invalid: boolean;
  describedBy: string | undefined;
}

const FieldContext = createContext<FieldWiring | null>(null);

/** The props a control inside a `Field` takes from it: its id, required and invalid states and its error.
 * The field owns the id and the required state, so its label and asterisk always match its control. */
function useFieldWiring() {
  const field = useContext(FieldContext);
  if (!field) return {};
  return {
    id: field.id,
    required: field.required,
    'aria-required': field.required || undefined,
    'aria-invalid': field.invalid || undefined,
    'aria-describedby': field.describedBy,
  };
}

/**
 * A labelled field. The label is a noun, never an instruction. A required
 * field's label ends in an asterisk and its control is marked required; the
 * others carry no mark. `error` is the server's or the check's words, shown
 * under the control.
 */
export function Field({
  id: chosenId,
  label,
  required = false,
  error,
  children,
  className,
}: {
  id?: string;
  label: string;
  required?: boolean;
  error?: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const generatedId = useId();
  const id = chosenId ?? generatedId;
  const errorId = `${id}-error`;
  const invalid = Boolean(error);
  return (
    <FieldContext.Provider value={{ id, required, invalid, describedBy: invalid ? errorId : undefined }}>
      <div className={cn('flex min-w-0 flex-col gap-1.5', className)} data-field="">
        <label htmlFor={id} className="text-label font-medium text-ink-2">
          {label}
          {required ? (
            <span aria-hidden className="ms-0.5 text-ink-3">
              *
            </span>
          ) : null}
        </label>
        {children}
        {invalid ? <FieldError id={errorId}>{error}</FieldError> : null}
      </div>
    </FieldContext.Provider>
  );
}

/** What is wrong with a value, under its control: Text after a `circle-alert`, never red. The control names it with `aria-describedby`. */
export function FieldError({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <p id={id} className={cn('m-0 flex items-center gap-1.5 text-meta text-ink', className)} data-field-error="">
      <CircleAlert aria-hidden size={14} strokeWidth={1.75} className="shrink-0 text-ink-2" />
      {children}
    </p>
  );
}

export interface InputProps extends ComponentProps<'input'> {
  /** A 15 px icon at the start, such as search. */
  icon?: ReactNode;
  /** Whatever ends the field: the key that focuses it, or a clear button. */
  end?: ReactNode;
  /** Classes for the box around the input; `className` styles the input itself. */
  boxClassName?: string;
}

/** A one-line field. Inside a `Field` it takes the field's id, required state and error. */
export function Input({ icon, end, boxClassName, className, id, required, ...props }: InputProps) {
  const wiring = useFieldWiring();
  return (
    <span
      className={cn(
        boxClass,
        'h-7.5 ps-2.25 pe-2 pointer-coarse:h-9 [&_svg]:size-[15px] [&_svg]:shrink-0',
        boxClassName,
      )}
    >
      {icon}
      <input id={id} required={required} {...wiring} {...props} className={cn(controlClass, 'h-full', className)} />
      {end}
    </span>
  );
}

/** A field for several lines: a description, a comment, a note. */
export function Textarea({ className, id, required, rows = 3, ...props }: ComponentProps<'textarea'>) {
  const wiring = useFieldWiring();
  return (
    <span className={cn(boxClass, 'items-stretch px-2.25 py-1.5')}>
      <textarea
        id={id}
        required={required}
        rows={rows}
        {...wiring}
        {...props}
        className={cn(controlClass, 'resize-none text-sm leading-5', className)}
      />
    </span>
  );
}

/** A choice among a few fixed values, drawn like a field with the theme's chevron. Inside a `Field` it takes the field's id. */
export function Select({ className, id, required, children, ...props }: ComponentProps<'select'>) {
  const wiring = useFieldWiring();
  return (
    <select
      id={id}
      required={required}
      {...wiring}
      {...props}
      className={cn(
        boxClass,
        'h-7.5 cursor-pointer border-0 ps-2.25 text-ink outline-none pointer-coarse:h-9',
        // The box's refused and disabled looks read what it holds; the select is its own box, so it reads itself.
        'aria-[invalid=true]:inset-ring-ink disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
    >
      {children}
    </select>
  );
}
