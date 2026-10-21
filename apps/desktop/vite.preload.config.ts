import { defineConfig } from 'vite';

// A sandboxed preload cannot require workspace modules: bundle everything except Electron.
export default defineConfig({});
