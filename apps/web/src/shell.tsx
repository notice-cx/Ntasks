import { DesignGallery, NtasksApp } from '@notice-cx/ntasks-ui';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

/** Pages that once had addresses outside /tasks; a link to an old address still opens its page. */
const MOVED = ['live', 'projects', 'members', 'settings'];

/**
 * The web app's addresses on the Worker's own origin: the app under /tasks,
 * signed in with the Worker's session cookie, and the design system's
 * gallery at /design. Any other address opens the board.
 */
export function Shell() {
  return (
    <Routes>
      <Route path="/tasks/*" element={<NtasksApp basePath="/tasks" />} />
      <Route path="/design" element={<DesignGallery />} />
      {MOVED.map((page) => (
        <Route key={page} path={`/${page}`} element={<Moved to={`/tasks/${page}`} />} />
      ))}
      <Route path="*" element={<Navigate to="/tasks" replace />} />
    </Routes>
  );
}

function Moved({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}
