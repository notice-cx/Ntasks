import react from '@vitejs/plugin-react';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // The tests run @notice-cx/ntasks-ui's source, so they need no build of the package
  // first; `vite build` takes the built package.
  resolve: { conditions: ['ntasks-source', ...defaultClientConditions] },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
