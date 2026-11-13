import { DesignGallery, NtasksApp } from '@notice-cx/ntasks-ui';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

/** Pages that once had addresses outside /tasks; a link to an old address still opens its page. */
const MOVED = ['live', 'projects', 'members', 'settings'];

/**
 * The web app uses the Worker's session cookie, with workspace pages under
 * /tasks and project pages under /projects. The gallery is at /design.
 */
export function Shell() {
  return (
    <Routes>
      <Route path="/design" element={<DesignGallery />} />
      {MOVED.map((page) => (
        <Route key={page} path={`/${page}`} element={<Moved to={`/tasks/${page}`} />} />
      ))}
      <Route path="*" element={<NtasksApp projectBasePath="/projects" />} />
    </Routes>
  );
}

function Moved({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}
