import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@notice-cx/ntasks-ui/styles.css';
import { Shell } from './shell';
import './shell.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element.');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </StrictMode>,
);
