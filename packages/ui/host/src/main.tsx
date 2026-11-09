import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { NtasksApp } from '@ntasks/ui';
import { createFixtureTasksApi } from '@ntasks/ui/fixture';
import '@ntasks/ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element.');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/tasks/*" element={<NtasksApp api={createFixtureTasksApi()} basePath="/tasks" />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

// @ts-expect-error The declarations reached the host: basePath takes an address.
export const wrong = <NtasksApp basePath={1} />;
