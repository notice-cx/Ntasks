/**
 * The development server's page (`vite --mode fixture`): the app over
 * invented tasks held in the page, at the addresses the web app serves it
 * at, with the design system's gallery at /design.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { createFixtureTasksApi } from '../src/fixture';
import { DesignGallery, NtasksApp } from '../src/index';
// The built stylesheet imports these itself (vite.config.ts).
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono/wght.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element.');

const api = createFixtureTasksApi();

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="design" element={<DesignGallery />} />
        <Route path="*" element={<NtasksApp api={api} projectBasePath="/projects" />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
