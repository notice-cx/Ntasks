import { Activity, ChartNoAxesColumn, List, Plus, Search, Settings, Target } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMemo } from 'react';
import { Avatar } from './ui/avatar';
import { Count } from './ui/badge';
import { IconButton } from './ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './ui/menu';
import { ProjectIcon } from './ProjectIcon';
import { NavItem, NavSection, Sidebar, SidebarHeader, SidebarSpacer, WorkspaceButton } from './ui/shell';
import { GitHubMark, StatusMark, WorkspaceIcon } from './ui/symbols';
import { useBoard } from '../hooks/useBoard';
import { useNow } from '../hooks/useNow';
import { useAnswerHides } from '../hooks/useTasks';
import { useAccount, useWorkspace } from '../hooks/useWorkspace';
import { NO_FILTERS } from '../lib/board-read';
import { activeNow } from '../lib/live';
import { NEW_WORKSPACE_STATE, SEARCH_STATE, SOURCE_URL } from '../lib/page-state';
import { isAgentActor } from '../lib/symbols';
import { actorKey } from '@ntasks/domain';
import { actorLabel, claimedModel, type BoardTask } from '../lib/task-model';
import { usePaths } from '../lib/paths';

/** The people and agents shown under People, at most this many. */
const PEOPLE = 6;

interface Person {
  actor: string;
  name: string;
  model: string | null;
  live: boolean;
}

/** Who holds open work: everyone with a task not closed, those working on one now first. */
export function peopleOf(tasks: readonly BoardTask[], nowMs: number): Person[] {
  const people = new Map<string, Person>();
  for (const task of tasks) {
    if (!task.assignee || task.status === 'closed') continue;
    // One row per sender a reader sees, whatever name each of its tasks was recorded under.
    const key = actorKey(task.assignee);
    const known = people.get(key);
    people.set(key, {
      actor: known?.actor ?? task.assignee,
      name: known?.name ?? actorLabel(task.assignee, task.actors),
      model: known?.model ?? claimedModel(task),
      live: (known?.live ?? false) || activeNow(task, nowMs),
    });
  }
  return [...people.values()].sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name));
}

function openCount(tasks: readonly BoardTask[]): number {
  return tasks.filter((task) => task.status !== 'closed').length;
}

/** Whether a filter's assignee, in any spelling, names this sender. */
function sameSender(assignee: string | null, actor: string): boolean {
  return assignee !== null && actorKey(assignee) === actorKey(actor);
}

/**
 * The open workspace's name, which opens the menu of the others and its
 * settings, and for a deployment admin New workspace.
 */
function WorkspaceSwitcher({ admin }: { admin: boolean }) {
  const { workspace, workspaces, switchTo } = useWorkspace();
  const navigate = useNavigate();
  const paths = usePaths();
  const { pathname, search, hash } = useLocation();
  // Pages that mean the same in every workspace, so a switch stays on them; any other page goes to the board.
  const sameInEvery = pathname === paths.live || paths.isSettings(pathname);
  return (
    <Menu>
      <MenuTrigger asChild>
        <WorkspaceButton data-workspace-switcher="">{workspace.name}</WorkspaceButton>
      </MenuTrigger>
      <MenuContent label="Workspaces">
        {workspaces.map((option) => (
          <MenuItem
            key={option.workspaceId}
            icon={<WorkspaceIcon workspaceId={option.workspaceId} name={option.name} size={16} />}
            checked={option.workspaceId === workspace.workspaceId}
            onSelect={() => {
              if (option.workspaceId === workspace.workspaceId) return;
              switchTo(option.workspaceId);
              if (!sameInEvery) void navigate(paths.board);
            }}
          >
            {option.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<Settings aria-hidden />} onSelect={() => void navigate(paths.settings)}>
          Settings
        </MenuItem>
        {admin ? (
          <MenuItem
            icon={<Plus aria-hidden />}
            onSelect={() => void navigate({ pathname, search, hash }, { state: { [NEW_WORKSPACE_STATE]: true } })}
          >
            New workspace
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/**
 * The app's navigation: the workspace, Waiting for you, Tasks, Live, Focus and Productivity, then
 * each project and each person or agent with open work, each a view of the
 * board, and at its foot Settings, where the projects and members are
 * managed, and the link to the source code.
 */
export function AppSidebar() {
  const { workspace, workspaces } = useWorkspace();
  const admin = useAccount(true).data?.deploymentAdmin === true;
  const board = useBoard(NO_FILTERS);
  const hides = useAnswerHides();
  const navigate = useNavigate();
  const paths = usePaths();
  const { pathname, search } = useLocation();
  const onBoard = pathname === paths.board;
  const params = new URLSearchParams(onBoard ? search : '');
  const narrowed = ['view', 'project', 'assignee', 'status', 'priority', 'label', 'q'].some((name) => params.has(name));
  const now = useNow();
  // Worked out once per read, answer and clock tick: a change of address alone draws the sidebar again.
  const { waiting, tasks, projects, people, active } = useMemo(() => {
    const fetchedAt = (task: BoardTask) =>
      board.projects.find((project) => project.key === task.project)?.fetchedAt ?? null;
    return {
      waiting: board.inbox.filter((task) => !hides(task.id, fetchedAt(task))).length,
      tasks: openCount(board.allTasks),
      projects: new Map(board.available.map((project) => [project.key, openCount(project.tasks)])),
      people: peopleOf(board.allTasks, now).slice(0, PEOPLE),
      active: board.allTasks.filter((task) => activeNow(task, now)).length,
    };
  }, [board, hides, now]);
  const boardSearch = onBoard ? search : '';

  return (
    <Sidebar aria-label="Ntasks">
      <SidebarHeader
        icon={<WorkspaceIcon workspaceId={workspace.workspaceId} name={workspace.name} />}
        name={workspaces.length > 1 || admin ? <WorkspaceSwitcher admin={admin} /> : workspace.name}
      >
        <IconButton
          size="sm"
          label="Search"
          shortcut="/"
          icon={<Search aria-hidden />}
          onClick={() => void navigate(`${paths.board}${boardSearch}`, { state: { [SEARCH_STATE]: Date.now() } })}
        />
      </SidebarHeader>
      <NavItem
        asChild
        icon={<StatusMark status="waiting" label={null} />}
        count={waiting > 0 ? <Count value={waiting} tone="wait" /> : undefined}
        active={onBoard && params.get('view') === 'waiting'}
      >
        <Link to={`${paths.board}?view=waiting`}>Waiting for you</Link>
      </NavItem>
      <NavItem asChild icon={<List aria-hidden />} count={tasks} active={onBoard && !narrowed}>
        <Link to={paths.board}>Tasks</Link>
      </NavItem>
      <NavItem
        asChild
        icon={<Activity aria-hidden />}
        count={active > 0 ? active : undefined}
        active={pathname === paths.live}
      >
        <Link to={paths.live}>Live</Link>
      </NavItem>
      <NavItem asChild icon={<Target aria-hidden />} active={pathname === paths.focus}>
        <Link to={paths.focus}>Focus</Link>
      </NavItem>
      <NavItem asChild icon={<ChartNoAxesColumn aria-hidden />} active={pathname === paths.productivity}>
        <Link to={paths.productivity}>Productivity</Link>
      </NavItem>
      {board.available.length > 0 ? (
        <NavSection title="Projects">
          {board.available.map((project) => (
            <NavItem
              key={project.key}
              asChild
              icon={<ProjectIcon project={project} />}
              count={project.ok ? projects.get(project.key) : undefined}
              active={onBoard && params.get('project') === project.key}
            >
              <Link to={`${paths.board}?project=${encodeURIComponent(project.key)}`}>{project.name}</Link>
            </NavItem>
          ))}
        </NavSection>
      ) : null}
      {people.length > 0 ? (
        <NavSection title="People">
          {people.map((person) => (
            <NavItem
              key={person.actor}
              asChild
              icon={
                <Avatar
                  name={person.name}
                  agent={isAgentActor(person.actor)}
                  model={person.model}
                  size={18}
                  live={person.live}
                  decorative
                />
              }
              active={onBoard && sameSender(params.get('assignee'), person.actor)}
            >
              <Link to={`${paths.board}?assignee=${encodeURIComponent(actorKey(person.actor))}`}>{person.name}</Link>
            </NavItem>
          ))}
        </NavSection>
      ) : null}
      <SidebarSpacer />
      <NavItem asChild icon={<Settings aria-hidden />} active={paths.isSettings(pathname)}>
        <Link to={paths.settings}>Settings</Link>
      </NavItem>
      <NavItem href={SOURCE_URL} icon={<GitHubMark size={16} />} data-source-link="">
        Source code
      </NavItem>
    </Sidebar>
  );
}
