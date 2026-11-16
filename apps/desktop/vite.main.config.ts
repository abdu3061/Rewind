import { defineConfig } from "vite";

// Workspace source is bundled; native modules and Node built-ins must be externalized explicitly.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ["node:sqlite", "sqlite"],
    },
  },
  optimizeDeps: {
    exclude: ["node:sqlite", "sqlite"],
  },
});
