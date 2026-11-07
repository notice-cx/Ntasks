import { List, Pencil, Search, Target } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Avatar } from '@/components/ui/avatar';
import { Count } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/button';
import { NavItem, NavSection, ProjectBadge, Sidebar, SidebarHeader, SidebarSpacer } from '@/components/ui/shell';
import { GitHubMark, StatusMark } from '@/components/ui/symbols';
import { useBoard } from '@/hooks/useBoard';
import { useAnswerHides, useCapabilities, writesAvailable } from '@/hooks/useTasks';
import { NO_FILTERS } from '@/lib/board-read';
import { COMPOSE_STATE, SEARCH_STATE, SOURCE_URL } from '@/lib/page-state';
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

/**
 * The app's navigation: Waiting for you, Tasks and Focus, then each project
 * and each person or agent with open work, each a view of the board, and the
 * link to the source code at its foot.
 */
export function AppSidebar() {
  const board = useBoard(NO_FILTERS);
  const hides = useAnswerHides();
  const writable = writesAvailable(useCapabilities());
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
      <SidebarHeader name="Ntasks">
        <IconButton
          size="sm"
          label="Search"
          shortcut="/"
          icon={<Search aria-hidden />}
          onClick={() => void navigate(`/tasks${boardSearch}`, { state: { [SEARCH_STATE]: Date.now() } })}
        />
        <IconButton
          size="sm"
          label="New task"
          shortcut="C"
          icon={<Pencil aria-hidden />}
          disabled={!writable}
          onClick={() => void navigate(`/tasks${boardSearch}`, { state: { [COMPOSE_STATE]: true } })}
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
      <NavItem href={SOURCE_URL} icon={<GitHubMark size={16} />} data-source-link="">
        Source code
      </NavItem>
    </Sidebar>
  );
}
