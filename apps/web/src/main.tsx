import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { createHttpTasksApi, type TasksApi } from '@/api/client';
import { App } from './App';
import { followSystemTheme } from './theme';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element.');

followSystemTheme(document.documentElement, window.matchMedia('(prefers-color-scheme: dark)'));

/** `vite --mode fixture` answers from invented tasks held in the page; every
 * other build reads the API on its own origin. The fixture is imported only
 * in that mode, so it never ships in a build. */
async function tasksApi(): Promise<TasksApi> {
  if (import.meta.env.MODE === 'fixture') {
    const { createFixtureTasksApi } = await import('@/api/fixture');
    return createFixtureTasksApi();
  }
  return createHttpTasksApi((input, init) => fetch(input, { ...init, credentials: 'same-origin' }));
}

void tasksApi().then((api) => {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App api={api} />
      </BrowserRouter>
    </StrictMode>,
  );
});
