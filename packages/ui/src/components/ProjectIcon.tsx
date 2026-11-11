import { useProjectIcon } from '../hooks/useTasks';
import { useScopeTheme } from '../lib/theme';
import { ProjectBadge } from './ui/shell';

/**
 * A project's mark: the icon read from its website once it is read, its
 * letter until then and when it has none. On a dark page it is the icon the
 * website declares for a dark scheme, else the light one; on a light page
 * only the light one, since a dark-scheme mark is drawn for a dark
 * background. The page's theme is the app's own, light, dark or the
 * system's, not only the system's.
 */
export function ProjectIcon({
  project,
  size,
  className,
}: {
  project: { readonly prefix: string; readonly icon?: string | null; readonly darkIcon?: string | null };
  size?: number;
  className?: string;
}) {
  const dark = useScopeTheme() === 'dark';
  const src = useProjectIcon((dark ? project.darkIcon : null) ?? project.icon);
  return <ProjectBadge prefix={project.prefix} src={src} size={size} className={className} />;
}
