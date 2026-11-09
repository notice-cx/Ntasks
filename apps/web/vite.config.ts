import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { serverFonts } from './server-fonts.config.ts';

export default defineConfig({
  plugins: [react(), serverFonts()],
});
