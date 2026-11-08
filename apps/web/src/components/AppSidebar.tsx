import { Folder, List, Search, Settings, Target, Users } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Avatar } from '@/components/ui/avatar';
import { Count } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import {
  NavItem,
  NavSection,
  ProjectBadge,
  Sidebar,
  SidebarHeader,
  SidebarSpacer,
  WorkspaceButton,
} from '@/components/ui/shell';
import { GitHubMark, StatusMark, WorkspaceIcon } from '@/components/ui/symbols';
import { useBoard } from '@/hooks/useBoard';
import { useAnswerHides } from '@/hooks/useTasks';
import { useWorkspace } from '@/hooks/useWorkspace';
import { NO_FILTERS } from '@/lib/board-read';
import { SEARCH_STATE, SOURCE_URL } from '@/lib/page-state';
import { isAgentActor } from '@/lib/symbols';
import { actorLabel, claimedModel, IN_PROGRESS, type BoardTask } from '@/lib/task-model';

/** The people and agents shown under People, at most this many. */
const PEOPLE = 6;

interface Person {
  actor: string;
  name: string;
  model: string | null;
  live: boolean;
}

/** Who holds open work: everyone with a task not closed, those working now first. */
export function peopleOf(tasks: readonly BoardTask[]): Person[] {
  const people = new Map<string, Person>();
  for (const task of tasks) {
    if (!task.assignee || task.status === 'closed') continue;
    const known = people.get(task.assignee);
    people.set(task.assignee, {
      actor: task.assignee,
      name: known?.name ?? actorLabel(task.assignee, task.actors),
      model: known?.model ?? claimedModel(task),
      live: (known?.live ?? false) || task.status === IN_PROGRESS,
    });
  }
  return [...people.values()].sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name));
}

/** Pages that mean the same in every workspace, so a switch stays on them; any other page goes to the board. */
const WORKSPACE_PAGES = new Set(['/projects', '/members', '/settings']);

/** The open workspace's name, which opens the menu of the others and its settings. */
function WorkspaceSwitcher() {
  const { workspace, workspaces, switchTo } = useWorkspace();
  const navigate = useNavigate();
  const { pathname } = useLocation();
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
              if (!WORKSPACE_PAGES.has(pathname)) void navigate('/tasks');
            }}
          >
            {option.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<Settings aria-hidden />} onSelect={() => void navigate('/settings')}>
          Settings
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/**
 * The app's navigation: the workspace, Waiting for you, Tasks and Focus, then
 * each project and each person or agent with open work, each a view of the
 * board, and at its foot the workspace's projects, members and settings and
 * the link to the source code.
 */
export function AppSidebar() {
  const { workspace, workspaces } = useWorkspace();
  const owner = workspace.role === 'owner';
  const board = useBoard(NO_FILTERS);
  const hides = useAnswerHides();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const onBoard = pathname === '/tasks';
  const params = new URLSearchParams(onBoard ? search : '');
  const narrowed = ['view', 'project', 'assignee', 'status', 'priority', 'label', 'q'].some((name) => params.has(name));
  const fetchedAt = (task: BoardTask) =>
    board.projects.find((project) => project.key === task.project)?.fetchedAt ?? null;
  const waiting = board.inbox.filter((task) => !hides(task.id, fetchedAt(task))).length;
  const open = (tasks: readonly BoardTask[]) => tasks.filter((task) => task.status !== 'closed').length;
  const people = peopleOf(board.allTasks).slice(0, PEOPLE);
  const boardSearch = onBoard ? search : '';

  return (
    <Sidebar aria-label="Ntasks">
      <SidebarHeader
        icon={<WorkspaceIcon workspaceId={workspace.workspaceId} name={workspace.name} />}
        name={workspaces.length > 1 ? <WorkspaceSwitcher /> : workspace.name}
      >
        <IconButton
          size="sm"
          label="Search"
          shortcut="/"
          icon={<Search aria-hidden />}
          onClick={() => void navigate(`/tasks${boardSearch}`, { state: { [SEARCH_STATE]: Date.now() } })}
        />
      </SidebarHeader>
      <NavItem
        asChild
        icon={<StatusMark status="waiting" label={null} />}
        count={waiting > 0 ? <Count value={waiting} tone="wait" /> : undefined}
        active={onBoard && params.get('view') === 'waiting'}
      >
        <Link to="/tasks?view=waiting">Waiting for you</Link>
      </NavItem>
      <NavItem asChild icon={<List aria-hidden />} count={open(board.allTasks)} active={onBoard && !narrowed}>
        <Link to="/tasks">Tasks</Link>
      </NavItem>
      <NavItem asChild icon={<Target aria-hidden />} active={pathname === '/tasks/focus'}>
        <Link to="/tasks/focus">Focus</Link>
      </NavItem>
      {board.available.length > 0 ? (
        <NavSection title="Projects">
          {board.available.map((project) => (
            <NavItem
              key={project.key}
              asChild
              icon={<ProjectBadge prefix={project.prefix} />}
              count={project.ok ? open(project.tasks) : undefined}
              active={onBoard && params.get('project') === project.key}
            >
              <Link to={`/tasks?project=${encodeURIComponent(project.key)}`}>{project.name}</Link>
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
              active={onBoard && params.get('assignee') === person.actor}
            >
              <Link to={`/tasks?assignee=${encodeURIComponent(person.actor)}`}>{person.name}</Link>
            </NavItem>
          ))}
        </NavSection>
      ) : null}
      <SidebarSpacer />
      <NavItem asChild icon={<Folder aria-hidden />} active={pathname === '/projects'}>
        <Link to="/projects">Projects</Link>
      </NavItem>
      {owner ? (
        <NavItem asChild icon={<Users aria-hidden />} active={pathname === '/members'}>
          <Link to="/members">Members</Link>
        </NavItem>
      ) : null}
      <NavItem asChild icon={<Settings aria-hidden />} active={pathname === '/settings'}>
        <Link to="/settings">Settings</Link>
      </NavItem>
      <NavItem href={SOURCE_URL} icon={<GitHubMark size={16} />} data-source-link="">
        Source code
      </NavItem>
    </Sidebar>
  );
}
