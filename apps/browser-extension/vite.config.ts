import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    minify: false,
    lib: { entry: 'src/background.ts', formats: ['es'], fileName: () => 'background.js' },
    emptyOutDir: true,
  },
});
