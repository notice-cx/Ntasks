/**
 * The design system's gallery at /design: every token, symbol and component,
 * drawn by the components themselves, as docs/design.md describes them. It
 * reads no tasks, so it opens without signing in. The theme switch draws the
 * page in light or dark whatever the system prefers.
 */
import {
  Activity,
  ArrowUpRight,
  Bell,
  Calendar,
  Check,
  ChevronDown,
  Clock,
  Command,
  Copy,
  CornerDownLeft,
  Ellipsis,
  GitPullRequest,
  Hand,
  Inbox,
  Keyboard,
  Link as LinkIcon,
  List,
  ListChecks,
  ListFilter,
  MessageSquare,
  Moon,
  Paperclip,
  Pencil,
  Plus,
  Search,
  SendHorizontal,
  Settings,
  Tag,
  Target,
  Undo2,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { SOURCE_URL } from '@/lib/page-state';
import type { TaskChoiceKey, TaskChoices } from '@/api/types';
import { Avatar, AvatarGroup, type AvatarSize } from '@/components/ui/avatar';
import { Badge, Count, Progress } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Segmented, Tabs, type ChoiceOption } from '@/components/ui/choice';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { Kbd } from '@/components/ui/kbd';
import { Menu, MenuContent, MenuItem, MenuPanel, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { ThemeScope } from '@/components/ui/popover';
import {
  GroupHeader,
  Row,
  RowActions,
  RowAge,
  RowAnswer,
  RowId,
  RowMeta,
  RowSpacer,
  RowTitle,
} from '@/components/ui/row';
import {
  AppShell,
  BarSpacer,
  NavItem,
  NavSection,
  ProjectBadge,
  Sidebar,
  SidebarHeader,
  SidebarSpacer,
  TopBar,
} from '@/components/ui/shell';
import { GitHubMark, NtasksLogo, PriorityMark, StatusMark, TypeMark } from '@/components/ui/symbols';
import { COLOUR_TOKENS, type ColourToken } from '@/lib/design-tokens';
import {
  PRIORITY_LABELS,
  STATUS_MARK_LABELS,
  TYPE_MARK_LABELS,
  type StatusMark as StatusMarkKey,
  type TypeMark as TypeMarkKey,
} from '@/lib/symbols';
import { cn } from '@/lib/utils';
import { DecisionAnswer } from './tasks/decision-card';

type Theme = 'system' | 'light' | 'dark';

const STATUS_ORDER: readonly StatusMarkKey[] = ['open', 'in-progress', 'blocked', 'waiting', 'parked', 'done'];
const TYPE_ORDER: readonly Exclude<TypeMarkKey, 'other'>[] = [
  'task',
  'bug',
  'feature',
  'epic',
  'decision',
  'approval',
  'chore',
  'gate',
];

const ICONS: readonly [string, LucideIcon][] = [
  ['search', Search],
  ['plus', Plus],
  ['list-filter', ListFilter],
  ['chevron-down', ChevronDown],
  ['ellipsis', Ellipsis],
  ['check', Check],
  ['x', X],
  ['list', List],
  ['target', Target],
  ['activity', Activity],
  ['bell', Bell],
  ['settings', Settings],
  ['hand', Hand],
  ['user-plus', UserPlus],
  ['tag', Tag],
  ['calendar', Calendar],
  ['clock', Clock],
  ['moon', Moon],
  ['link', LinkIcon],
  ['git-pull-request', GitPullRequest],
  ['message-square', MessageSquare],
  ['corner-down-left', CornerDownLeft],
  ['pencil', Pencil],
  ['copy', Copy],
  ['undo-2', Undo2],
  ['paperclip', Paperclip],
  ['keyboard', Keyboard],
  ['command', Command],
];

const TYPE_SAMPLES: readonly { name: string; spec: string; sample: ReactNode }[] = [
  { name: 'Page title', spec: '20/28 · 600', sample: <span className="text-page-title">Tasks</span> },
  {
    name: 'Task title',
    spec: '26/34 · 600',
    sample: <span className="text-task-title">Fix the broken reset link in the welcome email</span>,
  },
  { name: 'Heading', spec: '18/26 · 600', sample: <span className="text-heading">Choose the sign-in methods</span> },
  { name: 'Section', spec: '14/20 · 600', sample: <span className="text-sm font-semibold">Done when</span> },
  {
    name: 'Row title',
    spec: '14/20 · 500',
    sample: <span className="text-sm font-medium">Check the sign-in form with a screen reader</span>,
  },
  {
    name: 'Body',
    spec: '15/25 · 400',
    sample: (
      <span className="text-body">
        The reset link in the welcome email opens a page that says the link expired, even when it is new.
      </span>
    ),
  },
  { name: 'Label', spec: '13/20 · 500', sample: <span className="text-label font-medium">Waiting for you</span> },
  {
    name: 'Meta',
    spec: '12.5/16 · 400',
    sample: <span className="nums text-meta text-ink-3">web-k3m9.2 &nbsp; 40m &nbsp; 1/3</span>,
  },
  {
    name: 'Code',
    spec: 'JetBrains Mono 13/21',
    sample: <code className="font-mono text-code">resetUrl.searchParams.set('token', token);</code>,
  },
];

const SIGN_IN_OPTIONS: readonly ChoiceOption[] = [
  {
    key: 'a',
    label: 'Email link only',
    detail: 'One path to test. People without email access on this device wait for the link.',
    recommended: true,
  },
  { key: 'b', label: 'Email link and password', detail: 'Two paths to test and support.' },
  { key: 'c', label: 'Password only', detail: 'The current behaviour.' },
];

const WAITING: readonly {
  id: string;
  title: string;
  priority: number;
  age: string;
  answer: 'approve' | 'answer' | readonly ChoiceOption[];
}[] = [
  {
    id: 'web-g7p2',
    title: 'Approve sending the new sign-in page to every visitor',
    priority: 1,
    age: '1d',
    answer: 'approve',
  },
  {
    id: 'web-d4x1',
    title: 'Choose the sign-in methods the page offers',
    priority: 1,
    age: '3d',
    answer: SIGN_IN_OPTIONS,
  },
  {
    id: 'docs-r4s9',
    title: 'Choose where the API reference lives',
    priority: 2,
    age: '9d',
    answer: [
      { key: 'a', label: "In the repository's docs folder", recommended: true },
      { key: 'b', label: 'In a separate docs project' },
    ],
  },
  { id: 'web-q8n5', title: 'Confirm the support address on the error page', priority: 2, age: '5d', answer: 'answer' },
];

export default function DesignRoute() {
  const [theme, setTheme] = useState<Theme>('system');
  return (
    <ThemeScope theme={theme} className="min-h-screen bg-canvas text-ink" data-design-gallery="">
      <div className="mx-auto max-w-[1440px] px-16 pt-14 pb-20 max-md:px-6 max-sm:px-4">
        <Header theme={theme} onTheme={setTheme} />
        <Section title="Colour">
          <div className="grid grid-cols-2 gap-5 max-lg:grid-cols-1">
            <Palette theme="light" />
            <Palette theme="dark" />
          </div>
        </Section>
        <Section title="Type">
          <Panel>
            {TYPE_SAMPLES.map((row) => (
              <div
                key={row.name}
                className="grid grid-cols-[170px_1fr] items-baseline gap-5 border-b border-border py-3 last:border-b-0 max-sm:grid-cols-1 max-sm:gap-1"
              >
                <div>
                  <div className="text-label font-semibold">{row.name}</div>
                  <div className="text-meta text-ink-3">{row.spec}</div>
                </div>
                <div className="min-w-0">{row.sample}</div>
              </div>
            ))}
          </Panel>
        </Section>
        <Section title="Space, shape and depth">
          <div className="grid grid-cols-3 gap-5 max-lg:grid-cols-1">
            <Panel title="Spacing, 4 px base">
              <div className="flex items-end gap-3.5">
                {[2, 4, 6, 8, 12, 16, 20, 24, 32, 40].map((n) => (
                  <div key={n} className="grid justify-items-center gap-1.5">
                    <i className="block w-3.5 rounded-[2px] bg-accent/85" style={{ height: n * 2 }} />
                    <span className="nums text-meta text-ink-3">{n}</span>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Radii">
              <div className="flex flex-wrap gap-4.5">
                {(
                  [
                    ['rounded-sm', '4', 'Keys'],
                    ['rounded-md', '6', 'Buttons'],
                    ['rounded-lg', '8', 'Menus'],
                    ['rounded-xl', '12', 'Panels'],
                    ['rounded-full', 'Full', 'Avatars'],
                  ] as const
                ).map(([radius, size, use]) => (
                  <div key={radius} className="grid justify-items-center gap-2 text-center">
                    <i
                      className={cn(
                        'block h-11 bg-surface inset-ring inset-ring-border-strong',
                        radius,
                        radius === 'rounded-full' ? 'w-11' : 'w-16',
                      )}
                    />
                    <span className="text-meta leading-4 text-ink-3">
                      {size}
                      <br />
                      {use}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Elevation" className="bg-surface">
              <div className="flex gap-4">
                {(
                  [
                    ['inset-ring inset-ring-border', 'Flat: rows'],
                    ['inset-ring inset-ring-border shadow-raise', 'Raised: buttons'],
                    ['shadow-pop', 'Popover: menus'],
                  ] as const
                ).map(([look, name]) => (
                  <div key={name} className={cn('flex h-18 flex-1 items-end rounded-lg bg-background p-2.5', look)}>
                    <span className="text-meta text-ink-3">{name}</span>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </Section>
        <Section title="Symbols">
          <div className="grid grid-cols-2 gap-5 max-lg:grid-cols-1">
            <Panel title="Status">
              <SymbolGrid>
                {STATUS_ORDER.map((status) => (
                  <SymbolCell key={status} name={STATUS_MARK_LABELS[status]}>
                    <StatusMark status={status} label={null} />
                    <StatusMark status={status} size={20} label={null} />
                  </SymbolCell>
                ))}
              </SymbolGrid>
              <p className="m-0 mt-3 flex items-center gap-2 text-meta text-ink-3">
                <StatusMark status="done" muted label={null} />
                Closed with nothing shipped: Won't do, Duplicate, No longer needed
              </p>
            </Panel>
            <Panel title="Priority">
              <SymbolGrid columns={5}>
                {PRIORITY_LABELS.map((word, priority) => (
                  <SymbolCell key={word} name={word}>
                    <PriorityMark priority={priority} label={null} />
                    <PriorityMark priority={priority} size={20} label={null} />
                  </SymbolCell>
                ))}
              </SymbolGrid>
            </Panel>
            <Panel title="Task type">
              <SymbolGrid>
                {TYPE_ORDER.map((type) => (
                  <SymbolCell key={type} name={TYPE_MARK_LABELS[type]}>
                    <TypeMark type={type} label={null} />
                    <TypeMark type={type} size={20} label={null} />
                  </SymbolCell>
                ))}
              </SymbolGrid>
            </Panel>
            <Panel title="People and agents">
              <div className="flex flex-wrap items-end gap-x-5 gap-y-4">
                {(
                  [
                    ['Person, initials', { name: 'Example Owner' }],
                    ['Claude', { name: 'Claude', agent: true }],
                    ['Codex', { name: 'Codex', agent: true }],
                    ['Any other agent', { name: 'Build bot', agent: true }],
                  ] as const
                ).map(([caption, who]) => (
                  <div key={caption} className="grid justify-items-center gap-2">
                    <div className="flex items-end gap-2.5">
                      {([20, 28, 40] as const satisfies readonly AvatarSize[]).map((size) => (
                        <Avatar key={size} {...who} size={size} decorative />
                      ))}
                    </div>
                    <span className="whitespace-nowrap text-meta text-ink-3">{caption}</span>
                  </div>
                ))}
                <div className="grid justify-items-center gap-2">
                  <AvatarGroup>
                    <Avatar name="Example Owner" size={28} decorative />
                    <Avatar name="Claude" agent size={28} decorative />
                    <Avatar name="Codex" agent size={28} decorative />
                  </AvatarGroup>
                  <span className="text-meta text-ink-3">Group</span>
                </div>
                <div className="grid justify-items-center gap-2">
                  <Avatar name="Example Owner" size={28} live decorative />
                  <span className="text-meta text-ink-3">Active now</span>
                </div>
              </div>
            </Panel>
          </div>
        </Section>
        <Section
          title={
            <>
              Icons <span className="ms-2 text-label font-medium text-ink-3">Lucide, 16 px, 1.75 stroke</span>
            </>
          }
        >
          <Panel>
            <div className="grid grid-cols-14 gap-1.5 max-lg:grid-cols-7 max-sm:grid-cols-4">
              {ICONS.map(([name, Icon]) => (
                <div key={name} className="grid justify-items-center gap-2 px-0.5 pt-3.5 pb-2.5">
                  <Icon aria-hidden size={18} strokeWidth={1.75} />
                  <span className="whitespace-nowrap text-[10.5px] text-ink-3">{name}</span>
                </div>
              ))}
            </div>
          </Panel>
        </Section>
        <Section title="Components">
          <div className="grid grid-cols-3 gap-5 max-lg:grid-cols-1">
            <div className="grid grid-cols-1 content-start gap-4">
              <ButtonsPanel />
              <FieldsPanel />
              <MenuDemo />
            </div>
            <div className="grid grid-cols-1 content-start gap-4">
              <DecisionCard />
              <SignInCard />
            </div>
            <div className="grid grid-cols-1 content-start gap-4">
              <RowsSample />
              <Panel title="Labels and counts">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Badge dot>copy</Badge>
                  <Badge icon={<TypeMark type="bug" size={12} label={null} />}>Bug</Badge>
                  <Badge icon={<TypeMark type="epic" size={12} label={null} />}>Epic</Badge>
                  <Count value={4} tone="wait" />
                  <Count value={13} />
                  <Progress done={1} total={4} />
                </div>
              </Panel>
              <Panel title="Empty">
                <EmptyState
                  className="py-6"
                  icon={<Inbox />}
                  title="No tasks waiting for you"
                  action={
                    <Button size="sm">
                      <Target aria-hidden />
                      Focus
                    </Button>
                  }
                />
              </Panel>
            </div>
          </div>
          <WaitingRows />
        </Section>
        <Section title="Shell">
          <ShellSample />
        </Section>
      </div>
    </ThemeScope>
  );
}

function Header({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  return (
    <header className="grid grid-cols-[1fr_auto] items-end gap-6 border-b border-border pb-8 max-md:grid-cols-1">
      <div className="grid justify-items-start gap-3">
        <NtasksLogo size={28} />
        <h1 className="m-0 text-[40px] leading-11 font-semibold tracking-[-0.03em]">Ntasks design</h1>
        <Tabs
          label="Theme"
          items={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          value={theme}
          onChange={onTheme}
        />
      </div>
      <dl className="m-0 grid grid-cols-[auto_auto] gap-x-5 gap-y-1.5 text-label">
        {(
          [
            ['Typeface', 'Inter, JetBrains Mono for code'],
            ['Accent', 'Indigo #5552D4'],
            ['Icons', 'Lucide, 16 px, 1.75 stroke'],
            ['Density', '14 px text, 36 px rows'],
            [
              'Spec',
              <a
                key="spec"
                className="text-accent-text no-underline hover:underline"
                href={`${SOURCE_URL}/blob/main/docs/design.md`}
              >
                docs/design.md
              </a>,
            ],
            [
              'Source',
              <a
                key="source"
                className="text-accent-text no-underline hover:underline"
                href={SOURCE_URL}
                data-source-link=""
              >
                Source code
              </a>,
            ],
          ] as const
        ).map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-ink-3">{term}</dt>
            <dd className="m-0 font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </header>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="pt-10 pb-2">
      <h2 className="m-0 mb-4.5 text-page-title">{title}</h2>
      {children}
    </section>
  );
}

function Panel({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 rounded-xl bg-background p-5 inset-ring inset-ring-border', className)}>
      {title ? <h3 className="m-0 mb-3 text-label font-semibold text-ink-2">{title}</h3> : null}
      {children}
    </div>
  );
}

/** One theme's colours, drawn in that theme; each swatch's value is read back from the stylesheet. */
function Palette({ theme }: { theme: 'light' | 'dark' }) {
  const panel = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const style = getComputedStyle(element);
    setValues(
      Object.fromEntries(
        COLOUR_TOKENS.map((token) => [token.variable, style.getPropertyValue(token.variable).trim().toUpperCase()]),
      ),
    );
  }, []);
  return (
    <div
      ref={panel}
      className={cn(theme, 'rounded-xl bg-background p-5 text-ink inset-ring inset-ring-border')}
      data-palette={theme}
    >
      <h3 className="m-0 mb-3.5 text-label font-semibold">{theme === 'light' ? 'Light' : 'Dark'}</h3>
      <div className="grid grid-cols-3 gap-x-3 gap-y-3.5 max-sm:grid-cols-2">
        {COLOUR_TOKENS.map((token) => (
          <Swatch key={token.variable} token={token} value={values[token.variable] ?? ''} />
        ))}
      </div>
    </div>
  );
}

function Swatch({ token, value }: { token: ColourToken; value: string }) {
  return (
    <div
      className="grid grid-cols-[36px_1fr] items-center gap-x-2.5 gap-y-0.5"
      title={token.variable}
      data-swatch={token.variable}
    >
      <i
        className="row-span-2 block size-9 rounded-md inset-ring inset-ring-border"
        style={{ background: `var(${token.variable})` } as CSSProperties}
      />
      <b className="text-meta leading-4 font-semibold">
        {token.name} <span className="nums font-medium text-ink-3">{value}</span>
      </b>
      <span className="text-[11.5px] leading-[15px] text-ink-3">{token.role}</span>
    </div>
  );
}

function SymbolGrid({ children, columns = 6 }: { children: ReactNode; columns?: 5 | 6 }) {
  return (
    <div className={cn('grid gap-3 max-sm:grid-cols-3', columns === 6 ? 'grid-cols-6' : 'grid-cols-5')}>{children}</div>
  );
}

function SymbolCell({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid content-start justify-items-center gap-2.5 rounded-lg bg-surface px-1.5 pt-4 pb-3 text-center">
      <div className="flex items-center gap-3 text-ink-2">{children}</div>
      <span className="text-meta font-medium">{name}</span>
    </div>
  );
}

function ButtonsPanel() {
  return (
    <Panel title="Buttons">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="primary">
          <Plus aria-hidden strokeWidth={2} />
          New task <Kbd>C</Kbd>
        </Button>
        <Button>
          <ListFilter aria-hidden />
          Filter
        </Button>
        <Button variant="ghost">
          <Target aria-hidden />
          Focus <Kbd>F</Kbd>
        </Button>
        <IconButton variant="secondary" label="More" icon={<Ellipsis aria-hidden />} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <Button variant="primary" size="sm">
          <Check aria-hidden strokeWidth={2} />
          Approve
        </Button>
        <Button variant="primary" size="sm" className="brightness-108" tabIndex={-1}>
          Hover
        </Button>
        <Button size="sm" className="outline-2 outline-offset-2 outline-accent" tabIndex={-1}>
          Focus
        </Button>
        <Button size="sm" disabled>
          Disabled
        </Button>
        <IconButton size="sm" label="More" icon={<Ellipsis aria-hidden />} />
      </div>
    </Panel>
  );
}

function FieldsPanel() {
  return (
    <Panel title="Fields">
      <div className="grid gap-2.5">
        <Input icon={<Search aria-hidden />} placeholder="Search tasks" aria-label="Search tasks" end={<Kbd>/</Kbd>} />
        <Input
          defaultValue="support@example.com"
          aria-label="Email"
          boxClassName="inset-ring-accent ring-3 ring-accent-soft"
        />
        <div className="flex gap-2">
          <Input placeholder="Answer" aria-label="Answer" />
          <Button variant="primary">
            <SendHorizontal aria-hidden />
            Send
          </Button>
        </div>
        <Field label="Title" required>
          <Input defaultValue="Fix the broken reset link" />
        </Field>
        <Field label="Priority">
          <Select defaultValue="1">
            {PRIORITY_LABELS.map((word, priority) => (
              <option key={word} value={priority}>
                {word}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Email" error="This address has no @.">
          <Input defaultValue="support.example.com" />
        </Field>
      </div>
    </Panel>
  );
}

function MenuItems() {
  return (
    <>
      <MenuItem icon={<ArrowUpRight aria-hidden />} shortcut="↵">
        Open
      </MenuItem>
      <MenuItem icon={<Hand aria-hidden />} shortcut="M">
        Claim
      </MenuItem>
      <MenuItem icon={<UserPlus aria-hidden />} shortcut="A">
        Assign to
      </MenuItem>
      <MenuItem icon={<PriorityMark priority={1} label={null} />} shortcut="P">
        Priority
      </MenuItem>
      <MenuItem icon={<Moon aria-hidden />} shortcut="Z">
        Park
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Check aria-hidden />} submenu>
        Close as
      </MenuItem>
      <MenuItem icon={<Copy aria-hidden />} shortcut="⌘ .">
        Copy id
      </MenuItem>
    </>
  );
}

function MenuDemo() {
  return (
    <Panel title="Menu">
      <div className="flex flex-wrap items-start gap-4">
        <MenuPanel label="Task web-b2r6" className="shadow-pop [&>[role=menuitem]:nth-child(2)]:bg-hover">
          <MenuItems />
        </MenuPanel>
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm">
              <Ellipsis aria-hidden />
              Open a menu
            </Button>
          </MenuTrigger>
          <MenuContent label="Task web-b2r6">
            <MenuItems />
          </MenuContent>
        </Menu>
      </div>
    </Panel>
  );
}

const SIGN_IN_CHOICES: TaskChoices = {
  question: 'Which sign-in methods should the page offer?',
  options: SIGN_IN_OPTIONS.map(({ key, label, detail, recommended }) => ({
    key,
    label,
    ...(detail ? { detail } : {}),
    ...(recommended ? { recommended: true as const } : {}),
  })),
};

function DecisionCard() {
  const [picked, setPicked] = useState<TaskChoiceKey | null>('a');
  const [note, setNote] = useState('');
  return (
    <div className="rounded-xl bg-background px-5.5 pt-5.5 pb-4.5 shadow-pop">
      <div className="nums flex items-center gap-2 text-meta text-ink-3">
        <StatusMark status="waiting" label={null} />
        <b className="font-semibold text-wait-text">Your choice</b>
        <span>web-d4x1</span>
        <span>Example web app</span>
        <span className="ms-auto">3d</span>
      </div>
      <h4 className="m-0 mt-2.5 mb-1 text-heading">Choose the sign-in methods the page offers</h4>
      <p className="m-0 mb-3.5 text-sm text-ink-2">{SIGN_IN_CHOICES.question}</p>
      <DecisionAnswer
        choices={SIGN_IN_CHOICES}
        value={picked}
        onChange={setPicked}
        note={note}
        onNote={setNote}
        onAnswer={() => undefined}
        footer={
          <Button type="button" variant="ghost">
            Not now <Kbd>→</Kbd>
          </Button>
        }
      />
    </div>
  );
}

function SignInCard() {
  return (
    <div className="grid justify-items-start gap-1.5 rounded-xl bg-background p-7 shadow-pop">
      <NtasksLogo size={32} />
      <h4 className="m-0 mt-3.5 text-page-title">Sign in to Ntasks</h4>
      <Button variant="primary" className="mt-4 h-9 w-full text-sm">
        <GitHubMark size={16} />
        Sign in with GitHub
      </Button>
    </div>
  );
}

function RowsSample() {
  return (
    <div>
      <h3 className="m-0 mb-3 text-label font-semibold text-ink-2">Rows</h3>
      <div className="overflow-hidden rounded-xl bg-background inset-ring inset-ring-border [&>*:last-child]:border-b-0">
        <GroupHeader
          mark={<StatusMark status="waiting" label={null} />}
          label="Waiting for you"
          count={4}
          tone="wait"
        />
        <Row answer>
          <PriorityMark priority={1} />
          <RowId>web-g7p2</RowId>
          <StatusMark status="waiting" />
          <RowTitle>Approve sending the new sign-in page to every visitor</RowTitle>
          <RowSpacer />
          <RowAnswer>
            <Button variant="primary" size="sm">
              Approve
            </Button>
          </RowAnswer>
        </Row>
        <GroupHeader mark={<StatusMark status="in-progress" label={null} />} label="In progress" count={2} />
        <Row>
          <PriorityMark priority={1} />
          <RowId>web-k3m9.2</RowId>
          <StatusMark status="in-progress" />
          <RowTitle>Check the sign-in form with a screen reader</RowTitle>
          <RowSpacer />
          <Avatar name="Codex" agent />
          <RowAge>40m</RowAge>
        </Row>
        <Row className="bg-hover">
          <PriorityMark priority={0} />
          <RowId>web-b2r6</RowId>
          <StatusMark status="open" />
          <RowTitle>Fix the broken reset link in the welcome email</RowTitle>
          <RowSpacer />
          <RowActions className="inline-flex">
            <Button size="sm" tabIndex={-1}>
              <Hand aria-hidden />
              Claim
            </Button>
            <IconButton size="sm" label="More" icon={<Ellipsis aria-hidden />} tabIndex={-1} />
          </RowActions>
          <RowAge>9h</RowAge>
        </Row>
      </div>
      <p className="m-0 mx-0.5 mt-2 text-meta text-ink-3">Row actions show on hover and in the row menu.</p>
    </div>
  );
}

function WaitingRows() {
  return (
    <div className="mt-5">
      <h3 className="m-0 mb-3 text-label font-semibold text-ink-2">Waiting for you: answer in place</h3>
      <div className="overflow-hidden rounded-xl bg-background inset-ring inset-ring-border [&>*:last-child]:border-b-0">
        {WAITING.map((task) => (
          <Row key={task.id} answer>
            <PriorityMark priority={task.priority} />
            <RowId>{task.id}</RowId>
            <StatusMark status="waiting" />
            <RowTitle>{task.title}</RowTitle>
            <RowSpacer />
            <RowAnswer>
              {task.answer === 'approve' ? (
                <Button variant="primary" size="sm">
                  <Check aria-hidden strokeWidth={2} />
                  Approve
                </Button>
              ) : task.answer === 'answer' ? (
                <Button size="sm">
                  <CornerDownLeft aria-hidden />
                  Answer
                </Button>
              ) : (
                <Segmented question={task.title} options={task.answer} onChoose={() => undefined} />
              )}
            </RowAnswer>
            <RowAge>{task.age}</RowAge>
          </Row>
        ))}
      </div>
    </div>
  );
}

function ShellSample() {
  const [view, setView] = useState<'all' | 'active' | 'done'>('all');
  return (
    <div className="overflow-hidden rounded-xl inset-ring inset-ring-border">
      <AppShell
        className="min-h-0"
        sidebar={
          <Sidebar aria-label="Sample sidebar" className="static h-auto">
            <SidebarHeader name="Ntasks">
              <IconButton size="sm" label="Search" shortcut="/" icon={<Search aria-hidden />} />
              <IconButton size="sm" label="New task" shortcut="C" icon={<Pencil aria-hidden />} />
            </SidebarHeader>
            <NavItem
              href="#waiting"
              icon={<StatusMark status="waiting" label={null} />}
              count={<Count value={4} tone="wait" />}
            >
              Waiting for you
            </NavItem>
            <NavItem href="#tasks" icon={<List aria-hidden />} count={13} active>
              Tasks
            </NavItem>
            <NavItem href="#focus" icon={<Target aria-hidden />}>
              Focus
            </NavItem>
            <NavItem href="#activity" icon={<Activity aria-hidden />}>
              Activity
            </NavItem>
            <NavSection title="Projects">
              <NavItem href="#web" icon={<ProjectBadge prefix="web" />} count={9}>
                Example web app
              </NavItem>
              <NavItem href="#docs" icon={<ProjectBadge prefix="docs" />} count={4}>
                Example docs
              </NavItem>
            </NavSection>
            <NavSection title="People">
              <NavItem href="#you" icon={<Avatar name="Example Owner" size={18} live decorative />}>
                You
              </NavItem>
              <NavItem href="#claude" icon={<Avatar name="Claude" agent size={18} decorative />}>
                Claude
              </NavItem>
              <NavItem href="#codex" icon={<Avatar name="Codex" agent size={18} live decorative />}>
                Codex
              </NavItem>
            </NavSection>
            <SidebarSpacer />
            <NavItem href="#settings" icon={<Settings aria-hidden />}>
              Settings
            </NavItem>
          </Sidebar>
        }
      >
        <TopBar title="Tasks">
          <Tabs
            label="View"
            items={[
              { value: 'all', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'done', label: 'Done' },
            ]}
            value={view}
            onChange={setView}
          />
          <BarSpacer />
          <Input
            boxClassName="w-60 max-md:hidden"
            icon={<Search aria-hidden />}
            placeholder="Search tasks"
            aria-label="Search tasks"
            end={<Kbd>/</Kbd>}
          />
          <Button>
            <ListFilter aria-hidden />
            Filter
          </Button>
          <Button variant="primary">
            <Plus aria-hidden strokeWidth={2} />
            New task <Kbd>C</Kbd>
          </Button>
        </TopBar>
        <GroupHeader
          mark={<StatusMark status="waiting" label={null} />}
          label="Waiting for you"
          count={4}
          tone="wait"
          end={
            <Button variant="ghost" size="sm">
              <Target aria-hidden />
              Focus <Kbd>F</Kbd>
            </Button>
          }
        />
        <Row answer>
          <PriorityMark priority={1} />
          <RowId>web-g7p2</RowId>
          <StatusMark status="waiting" />
          <RowTitle>Approve sending the new sign-in page to every visitor</RowTitle>
          <RowSpacer />
          <RowAnswer>
            <Button variant="primary" size="sm">
              <Check aria-hidden strokeWidth={2} />
              Approve
            </Button>
          </RowAnswer>
          <RowAge>1d</RowAge>
        </Row>
        <GroupHeader
          mark={<StatusMark status="in-progress" label={null} />}
          label="In progress"
          count={2}
          open
          onToggle={() => undefined}
        />
        <Row>
          <PriorityMark priority={1} />
          <RowId>web-k3m9.2</RowId>
          <StatusMark status="in-progress" />
          <RowTitle>Check the sign-in form with a screen reader</RowTitle>
          <RowMeta>
            <ListChecks aria-hidden />
            1/3
          </RowMeta>
          <RowMeta>
            <MessageSquare aria-hidden />1
          </RowMeta>
          <RowSpacer />
          <Avatar name="Codex" agent />
          <RowAge>40m</RowAge>
        </Row>
        <GroupHeader
          mark={<StatusMark status="open" label={null} />}
          label="Open"
          count={4}
          open
          onToggle={() => undefined}
        />
        <Row>
          <PriorityMark priority={0} />
          <RowId>web-b2r6</RowId>
          <StatusMark status="open" />
          <RowTitle>Fix the broken reset link in the welcome email</RowTitle>
          <Badge icon={<TypeMark type="bug" size={12} label={null} />}>Bug</Badge>
          <RowSpacer />
          <RowAge>9h</RowAge>
        </Row>
        <Row>
          <PriorityMark priority={1} />
          <RowId>web-k3m9</RowId>
          <StatusMark status="open" />
          <RowTitle>Ship the new sign-in page</RowTitle>
          <Badge icon={<TypeMark type="epic" size={12} label={null} />}>Epic</Badge>
          <Progress done={1} total={4} />
          <RowSpacer />
          <RowAge>12d</RowAge>
        </Row>
        <GroupHeader
          mark={<StatusMark status="blocked" label={null} />}
          label="Blocked"
          count={1}
          open
          onToggle={() => undefined}
        />
        <Row>
          <PriorityMark priority={1} />
          <RowId>web-k3m9.3</RowId>
          <StatusMark status="blocked" />
          <RowTitle>Send the new sign-in page to every visitor</RowTitle>
          <RowMeta>
            <LinkIcon aria-hidden />
            Waits on <span className="text-ink-2">web-k3m9.2, web-g7p2</span>
          </RowMeta>
          <RowSpacer />
          <RowAge>2d</RowAge>
        </Row>
        <GroupHeader
          mark={<StatusMark status="done" label={null} />}
          label="Done"
          count={3}
          open={false}
          onToggle={() => undefined}
        />
      </AppShell>
    </div>
  );
}
