import { useProjectIcon } from '../hooks/useTasks';
import { ProjectBadge } from './ui/shell';

/** A project's mark: the icon read from its website once it is read, its letter until then and when it has none. */
export function ProjectIcon({
  project,
  size,
  className,
}: {
  project: { readonly prefix: string; readonly icon?: string | null };
  size?: number;
  className?: string;
}) {
  const src = useProjectIcon(project.icon);
  return <ProjectBadge prefix={project.prefix} src={src} size={size} className={className} />;
}
